from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids.add(attrs["id"])
        for key in ("href", "src"):
            if attrs.get(key):
                self.links.append(attrs[key])


pages = {}
for path in ROOT.glob("*.html"):
    page = Page()
    page.feed(path.read_text(encoding="utf-8"))
    pages[path] = page

errors = []
for source, page in pages.items():
    for link in page.links:
        url = urlsplit(link)
        if url.scheme or url.netloc or link.startswith(("mailto:", "tel:", "//")):
            continue
        target = (source.parent / unquote(url.path)).resolve() if url.path else source
        if not target.is_relative_to(ROOT) or not target.is_file():
            errors.append(f"{source.name}: missing {link}")
        elif url.fragment and target.suffix == ".html":
            target_page = pages.get(target)
            if target_page is None or unquote(url.fragment) not in target_page.ids:
                errors.append(f"{source.name}: missing anchor {link}")

if errors:
    raise SystemExit("\n".join(errors))
print(f"Checked {len(pages)} website pages and their local links.")
