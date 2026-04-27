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
from urllib.parse import urljoin

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
# BeautifulSoup is for the heuristic fallback — used when a page has no
# JSON-LD / microdata at all (e.g., personal chef blogs that don't bother
# with SEO recipe markup).
from bs4 import BeautifulSoup

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


# === Heuristic fallback for sites without structured data ===
#
# Some recipe pages (especially personal chef blogs like adamliaw.com) render
# perfectly readable recipes in HTML but expose zero JSON-LD / microdata, so
# recipe-scrapers can't extract anything. We fall back to "read the page like
# a person would": find a heading containing "Ingredients" and grab the list
# right after it. Same for "Method" / "Instructions" / "Directions".
#
# This is intentionally simple. Anything fancier (table-based ingredients,
# inline paragraph recipes, multi-column layouts) is a job for AI extraction
# at the Pro tier later.

INGREDIENT_HEADER_RE = re.compile(r"^\s*ingredients?\s*$", re.I)
INSTRUCTION_HEADER_RE = re.compile(
    r"^\s*(method|instructions?|directions?|preparation|steps?|how to make|to cook|to make)\s*$",
    re.I,
)
# Match "Serves 4", "Makes 12", "Yields 6", "Serves 4-6" — the leading-digit
# group is what we keep. Used to both pull servings out and filter the line
# out of the ingredient list.
SERVINGS_LINE_RE = re.compile(
    r"^\s*(?:serves|makes|yields?)\s*:?\s*(\d+)",
    re.I,
)
SERVINGS_TRAILING_RE = re.compile(r"^\s*(\d+)\s+servings?\s*$", re.I)


def _items_from_list_after(header_tag):
    """Given a heading element, find the next <ul> or <ol> and return its
    <li> texts. Returns an empty list if no list is found nearby."""
    list_el = header_tag.find_next(["ol", "ul"])
    if not list_el:
        return []
    items = []
    for li in list_el.find_all("li", recursive=False) or list_el.find_all("li"):
        text = li.get_text(" ", strip=True)
        # Collapse runs of whitespace; some sites have weird non-breaking spaces.
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            items.append(text)
    return items


def _meta_content(soup, prop):
    """og:title / og:image style meta lookup. Tries `property=` first
    (proper OpenGraph), falls back to `name=` (Twitter cards / older sites)."""
    tag = soup.find("meta", property=prop)
    if not tag:
        tag = soup.find("meta", attrs={"name": prop})
    if tag and tag.get("content"):
        return tag["content"].strip()
    return ""


def _find_recipe_title(soup, ingredients_header):
    """Pick the heading most likely to be the recipe title.

    Priority:
      1. The heading immediately preceding the "Ingredients" header — this
         is the recipe-name pattern almost every food blog follows, and it
         beats meta tags on sites where og:title is hijacked by ads.
      2. og:title meta.
      3. First <h1> in the document.
      4. <title> tag.
    """
    if ingredients_header is not None:
        prev = ingredients_header.find_previous(["h1", "h2", "h3"])
        if prev:
            text = re.sub(r"\s+", " ", prev.get_text(" ", strip=True)).strip()
            if text and len(text) < 120:
                return text

    title = _meta_content(soup, "og:title")
    if title:
        return re.sub(r"\s+", " ", title).strip()

    h1 = soup.find("h1")
    if h1:
        return re.sub(r"\s+", " ", h1.get_text(" ", strip=True)).strip()

    title_tag = soup.find("title")
    if title_tag:
        return re.sub(r"\s+", " ", title_tag.get_text(strip=True)).strip()
    return ""


def _find_recipe_image(soup, page_url):
    """og:image → twitter:image → first reasonably-sized <img> inside an
    article/main region. Returns an absolute URL (or "" if nothing usable)."""
    img = _meta_content(soup, "og:image")
    if img:
        return urljoin(page_url, img)
    img = _meta_content(soup, "twitter:image")
    if img:
        return urljoin(page_url, img)
    region = soup.find(["article", "main"]) or soup
    for el in region.find_all("img"):
        src = el.get("src") or el.get("data-src") or ""
        if not src or src.startswith("data:"):
            continue
        low = src.lower()
        # Skip obvious icons / avatars / spacers.
        if any(s in low for s in ("logo", "icon", "favicon", "spacer", "1x1", "avatar")):
            continue
        # Image proxies (Next.js, Cloudinary, etc.) embed a width hint as ?w=NNN.
        # If the hint says it's small, it's almost certainly an avatar or thumbnail.
        m = re.search(r"[?&]w=(\d+)", src)
        if m and int(m.group(1)) < 300:
            continue
        # Same idea for explicit width attributes on the <img> tag itself.
        width_attr = el.get("width") or ""
        if width_attr.isdigit() and int(width_attr) < 300:
            continue
        return urljoin(page_url, src)
    return ""


def _filter_ingredient_items(items):
    """Strip out servings lines that some sites bury inside the ingredient
    <ul> as the first list item. Returns (filtered_items, extracted_servings)."""
    extracted_servings = None
    cleaned = []
    for item in items:
        # Match either "Serves 4" / "Makes 12" or "4 servings" exactly.
        m = SERVINGS_LINE_RE.match(item) or SERVINGS_TRAILING_RE.match(item)
        if m:
            if extracted_servings is None:
                try:
                    extracted_servings = int(m.group(1))
                except (ValueError, IndexError):
                    pass
            continue
        cleaned.append(item)
    return cleaned, extracted_servings


def heuristic_parse(html, page_url=""):
    """Last-resort recipe extractor. Returns the same dict shape as the
    structured-data path so the caller can swap it in transparently.
    `page_url` is used to make image src URLs absolute."""
    soup = BeautifulSoup(html, "html.parser")

    # Find the Ingredients heading first — both the title heuristic and the
    # ingredient extractor key off it.
    ingredients_header = None
    for tag in soup.find_all(["h1", "h2", "h3", "h4", "h5"]):
        if INGREDIENT_HEADER_RE.match(tag.get_text(strip=True)):
            ingredients_header = tag
            break

    raw_ingredients = (
        _items_from_list_after(ingredients_header) if ingredients_header else []
    )
    ingredients, extracted_servings = _filter_ingredient_items(raw_ingredients)

    # Instructions — same heading-then-list pattern.
    instructions = []
    for tag in soup.find_all(["h1", "h2", "h3", "h4", "h5"]):
        if INSTRUCTION_HEADER_RE.match(tag.get_text(strip=True)):
            instructions = _items_from_list_after(tag)
            if instructions:
                break

    # Servings — first prefer what was inside the ingredient list (since
    # that's authored intent for THIS recipe specifically). Fall back to
    # scanning body text, which can pick up "4 servings" elsewhere.
    servings = extracted_servings
    if servings is None:
        body_text = soup.get_text(" ", strip=True)
        m = SERVINGS_LINE_RE.search(body_text) or SERVINGS_TRAILING_RE.search(body_text)
        if m:
            try:
                servings = int(m.group(1))
            except (ValueError, IndexError):
                servings = None

    title = _find_recipe_title(soup, ingredients_header)
    image = _find_recipe_image(soup, page_url)

    return {
        "title": title,
        "servings": servings,
        "ingredients": ingredients,
        "ingredient_groups": (
            [{"purpose": None, "ingredients": ingredients}] if ingredients else []
        ),
        "instructions": instructions,
        "image": image,
    }


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

    # === Path 1: structured data (recipe-scrapers) ===
    # Works on ~580 known sites + anything that exposes JSON-LD / microdata.
    parsed = None
    try:
        scraper = scrape_html(html=response.text, org_url=url, wild_mode=True)
        ingredient_groups = get_ingredient_groups(scraper)
        flat_ingredients = []
        for g in ingredient_groups:
            flat_ingredients.extend(g["ingredients"])
        if flat_ingredients:
            parsed = {
                "title": safe_call(scraper.title, ""),
                "servings": parse_servings(safe_call(scraper.yields, None)),
                "ingredients": flat_ingredients,
                "ingredient_groups": ingredient_groups,
                "instructions": safe_call(scraper.instructions_list, []),
                "image": safe_call(scraper.image, ""),
            }
    except Exception:
        # Swallow and fall through — heuristic path below may still rescue it.
        parsed = None

    # === Path 2: heuristic fallback ===
    # Triggers when path 1 found nothing (page has no structured data, or
    # recipe-scrapers raised). Catches plain-HTML chef sites like
    # adamliaw.com.
    if parsed is None or not parsed.get("ingredients"):
        fallback = heuristic_parse(response.text, url)
        if fallback["ingredients"]:
            parsed = fallback

    if parsed is None or not parsed.get("ingredients"):
        return jsonify({
            "error": (
                "Couldn't find a recipe on that page. Try pasting the "
                "ingredient text into PrepFresh manually."
            ),
        }), 422

    return jsonify({"url": url, **parsed})


if __name__ == "__main__":
    # host="127.0.0.1" means "only this computer can reach the server"
    # port=5000 is Flask's default. We can change it later if needed.
    # debug=True auto-reloads when we save changes — handy during development.
    app.run(host="127.0.0.1", port=5000, debug=True)
