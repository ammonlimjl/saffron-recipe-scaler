"""
PrepFresh — backend service.
Phase 2, Sub-step 2: adds /import endpoint that fetches recipe pages.

Run locally:
    python server.py

Endpoints:
    GET /                  Service info
    GET /health            Health check
    GET /import?url=...    Fetch a URL and return HTML metadata
"""

import re

from flask import Flask, jsonify, request
from flask_cors import CORS
# curl_cffi mimics a real Chrome's TLS fingerprint so most Cloudflare /
# DataDome bot walls let us through. Falls back gracefully on sites that
# require JavaScript challenges.
from curl_cffi import requests as cffi_requests
from curl_cffi.requests import RequestsError
# recipe-scrapers has 580+ site-specific parsers and falls back to generic
# JSON-LD / microdata for unrecognized sites. Industry standard.
from recipe_scrapers import scrape_html

app = Flask(__name__)

# CORS = Cross-Origin Resource Sharing. Browsers block JavaScript on one site
# from calling APIs on another site unless the API explicitly says it's OK.
# This line says "any website is allowed to call us." We'll tighten it later.
CORS(app)

# curl_cffi will set the User-Agent to match its impersonate target. We pass
# additional headers here that real browsers also send. Operating at the
# user's explicit request (not as a crawler) — same pattern as RSS readers.
FETCH_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

FETCH_TIMEOUT_SECONDS = 10
IMPERSONATE_TARGET = "chrome120"


# recipe-scrapers handles all the JSON-LD / microdata / site-specific parsing
# under the hood (it knows ~580 sites). We only need a tiny helper to turn its
# yields() string ("4 servings", "Makes 12") into a clean integer.

def parse_servings(value):
    """yields() can be a string ('4 servings'), int, float, or list."""
    if value is None:
        return None
    if isinstance(value, list):
        for item in value:
            n = parse_servings(item)
            if n:
                return n
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        m = re.search(r"\d+", value)
        if m:
            return int(m.group())
    return None


def safe_call(fn, default):
    """Recipe-scrapers methods can raise when a field is missing on a given
    page. Wrap each call so a single missing field doesn't break the response."""
    try:
        return fn() or default
    except Exception:
        return default


def get_ingredient_groups(scraper):
    """Return ingredient groups with section headers preserved (e.g.,
    'Optional add-ins'). Falls back to a single ungrouped list when the
    scraper doesn't expose ingredient_groups()."""
    try:
        groups = scraper.ingredient_groups()
        result = []
        for g in groups:
            ingredients = list(getattr(g, "ingredients", []) or [])
            if not ingredients:
                continue
            result.append({
                "purpose": getattr(g, "purpose", None),
                "ingredients": ingredients,
            })
        if result:
            return result
    except Exception:
        pass
    ingredients = safe_call(scraper.ingredients, [])
    return [{"purpose": None, "ingredients": ingredients}] if ingredients else []


@app.route("/")
def index():
    """Root endpoint — confirms the server is alive."""
    return jsonify({
        "service": "PrepFresh backend",
        "status": "ok",
        "message": "Hello from Python!",
    })


@app.route("/health")
def health():
    """Health check endpoint — used by hosting platforms like Render."""
    return jsonify({"status": "healthy"})


@app.route("/import")
def import_recipe():
    """Fetch a recipe URL. Returns HTML metadata + preview for now;
    Sub-step 3 will parse out the actual recipe data."""
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "Missing 'url' query parameter."}), 400
    if not (url.startswith("http://") or url.startswith("https://")):
        return jsonify({"error": "URL must start with http:// or https://"}), 400

    try:
        response = cffi_requests.get(
            url,
            timeout=FETCH_TIMEOUT_SECONDS,
            headers=FETCH_HEADERS,
            impersonate=IMPERSONATE_TARGET,
        )
    except RequestsError as e:
        msg = str(e).lower()
        if "timeout" in msg or "timed out" in msg:
            return jsonify({"error": "The recipe page took too long to respond."}), 504
        return jsonify({"error": f"Couldn't fetch that URL: {e}"}), 502

    if response.status_code >= 400:
        return jsonify({
            "error": f"That site blocked the request (HTTP {response.status_code}).",
            "status_code": response.status_code,
        }), 502

    try:
        scraper = scrape_html(html=response.text, org_url=url, wild_mode=True)
    except Exception:
        return jsonify({
            "error": (
                "Couldn't find a recipe on that page. Try pasting the "
                "ingredient text into PrepFresh manually."
            ),
        }), 422

    ingredient_groups = get_ingredient_groups(scraper)
    flat_ingredients = []
    for g in ingredient_groups:
        flat_ingredients.extend(g["ingredients"])

    parsed = {
        "title": safe_call(scraper.title, ""),
        "servings": parse_servings(safe_call(scraper.yields, None)),
        "ingredients": flat_ingredients,
        "ingredient_groups": ingredient_groups,
        "instructions": safe_call(scraper.instructions_list, []),
        "image": safe_call(scraper.image, ""),
    }

    # If we got nothing useful (no ingredients), treat as a parse failure.
    if not parsed["ingredients"]:
        return jsonify({
            "error": (
                "Couldn't find recipe ingredients on that page. Try pasting "
                "the ingredient text into PrepFresh manually."
            ),
        }), 422

    return jsonify({"url": url, **parsed})


if __name__ == "__main__":
    # host="127.0.0.1" means "only this computer can reach the server"
    # port=5000 is Flask's default. We can change it later if needed.
    # debug=True auto-reloads when we save changes — handy during development.
    app.run(host="127.0.0.1", port=5000, debug=True)
