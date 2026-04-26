---
name: shared-files
description: Share files with users via public URLs. Save files to /workspace/shared-files/ and they become downloadable links. Trigger phrases include "serve as file", "share as file", "make a link", "give me a link".
---

# Sharing Files

When the user says **"serve as file"**, **"share as file"**, **"make a link"**, or **"give me a link"**, take whatever content was just discussed or generated (code, text, data, etc.), save it to a file, and return a clickable URL.

## How it works

**Step 1 — Resolve the group name (do this FIRST, every time):**

```bash
GROUP_NAME=$(basename $(readlink -f /workspace/group))
echo "Group: $GROUP_NAME"
```

This returns the actual folder name (e.g. `slack_main`, `slack_project-forge`). **Never use the literal word "group" in the URL.**

**Step 2 — Save the file:**

Save directly into `/workspace/shared-files/` — **flat, no subdirectories**. Do NOT create a folder named after the group; the mount already namespaces by group.

```bash
cat > /workspace/shared-files/myfile.py << 'EOF'
# content here
EOF
```

Correct: `/workspace/shared-files/myfile.py`
Wrong: `/workspace/shared-files/${GROUP_NAME}/myfile.py` (creates a broken double-nested path)

**Step 3 — Reply with the URL using the resolved group name:**

The group name appears in the **URL only**, not in the file path. The URL pattern is: `https://code.goette.co/files/${GROUP_NAME}/<filename>`

## Example

```bash
GROUP_NAME=$(basename $(readlink -f /workspace/group))
cat > /workspace/shared-files/script.py << 'PYEOF'
print("hello")
PYEOF
echo "https://code.goette.co/files/${GROUP_NAME}/script.py"
```

Then reply with the echoed URL, e.g.:
> Here's your file: https://code.goette.co/files/slack_project-forge/script.py

## Guidelines
- Pick a descriptive filename with the right extension (`.py`, `.csv`, `.html`, `.md`, `.json`, etc.)
- For code, use the appropriate source extension
- For formatted content (tables, reports), consider `.html` for rich rendering or `.md` for plain text
- Files are automatically cleaned up after 7 days
- Any file type is supported
