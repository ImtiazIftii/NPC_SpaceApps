"""
backend/services/country_service.py

Services for loading country registry, metadata, and spatial bounding boxes.
"""

import json
from pathlib import Path
from typing import List, Optional, Tuple, Dict, Any
from fastapi import HTTPException

from backend.core.config import COUNTRIES_DIR, REGISTRY_PATH


def get_country_dir(iso: str) -> Optional[Path]:
    """Resolve directory for a given country code if pre-processed, else None."""
    iso_clean = iso.upper().strip()
    cdir = COUNTRIES_DIR / iso_clean
    if cdir.exists():
        return cdir
    return None


def parse_bbox(bbox_str: Optional[str]) -> Optional[Tuple[float, float, float, float]]:
    """Parse 'minLon,minLat,maxLon,maxLat' string into float tuple, rounded to 1 decimal place."""
    if not bbox_str:
        return None
    try:
        parts = [round(float(x.strip()), 1) for x in bbox_str.split(",")]
        if len(parts) != 4:
            return None
        min_lon, min_lat, max_lon, max_lat = parts
        return (min_lon, min_lat, max_lon, max_lat)
    except Exception:
        return None


def get_country_metadata(iso: str) -> Dict[str, Any]:
    """Load metadata dictionary for the specified country from disk or registry."""
    iso_clean = iso.upper().strip()
    cdir = get_country_dir(iso_clean)
    if cdir:
        meta_path = cdir / "meta.json"
        if meta_path.exists():
            with open(meta_path, "r", encoding="utf-8") as f:
                return json.load(f)

    # Fallback to registered country profile in countries.json
    all_profiles = get_all_countries_registry()
    profile = next((c for c in all_profiles if c.get("iso") == iso_clean), None)
    if profile:
        return profile

    raise HTTPException(
        status_code=404,
        detail=f"Country '{iso_clean}' not found in registry. Please verify /api/countries."
    )


def get_all_countries_registry() -> List[Dict[str, Any]]:
    """Return list of all registered country profiles from countries.json."""
    if not REGISTRY_PATH.exists():
        return []
    with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

