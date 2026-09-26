---
name: document-image-generation
description: Generate an original image with Codex and place it in the open HWP/HWPX document when the user asks for an illustration, diagram, or other new visual.
icon: sparkles
---

Use Codex's native image generation tool for the requested visual. Read the relevant document context first so the subject, labels, and style fit the page. Keep text inside generated images to a minimum; write precise labels in the document when possible.

In planning or question mode, discuss the visual without editing the document. Generate and insert it only in a direct turn or after the implementation plan is approved.

For a request to illustrate the open document, complete the insertion in the same turn:

1. Generate the image, then copy the final PNG or JPEG into the session working directory. Codex may save its output under `CODEX_HOME/generated_images`, which `insert_image` cannot read directly. `insert_image` accepts an absolute local path under the working directory and files up to 5 MB; convert or compress the image there if needed.
2. Call `get_structure` for the current revision and insertion address. Use `insert_image` with `imagePath`, `expectedRevision`, `sectionIdx`, `paraIdx`, `charOffset` and `render: "crop"`. Set a useful `description` and an explicit width when the surrounding layout calls for one.
3. Check the crop and `after` warnings. Fix placement or size with `edit_object` (resize, float and position in mm, or change the wrap), measuring with `get_page_geometry`, instead of inserting again.

If the user asks only for an image asset, provide the generated asset without editing the document. Do not modify the source HWP/HWPX file through filesystem tools.
