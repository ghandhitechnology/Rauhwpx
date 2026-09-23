# Website

The public site at [heemangstudios.com](https://heemangstudios.com/) lives here. GitHub Pages publishes this directory when website changes land on `main`. Repository checks validate local links and assets on pull requests, and Pages runs the same check before deployment.

To preview it locally, run `python3 -m http.server 8000 --directory website` from the repository root and open `http://localhost:8000`. Run `python3 website/check.py` before submitting site changes.

The download buttons use the latest GitHub release assets when the GitHub API is available. Their fallback opens the latest release page.
