import os
import re

files = ["adminDB.html", "staffDB.html", "memberDB.html", "trainerDB.html", "index.html", "js/ui.js", "js/script.js", "js/bookings-ui.js"]
base_dir = "/Users/louiseadrianvnonog/XFitTrack/MCSPROJ"

for f in files:
    filepath = os.path.join(base_dir, f)
    if not os.path.exists(filepath):
        continue
        
    with open(filepath, "r") as file:
        content = file.read()
        
    # Replace background-color: var(--primary-red); with var(--dark-black); in buttons
    # We can do this safely by matching button tags
    new_content = re.sub(
        r'(<button[^>]*style=["\'][^"\']*)var\(--primary-red\)([^"\']*["\'][^>]*>)',
        r'\1var(--dark-black)\2',
        content,
        flags=re.IGNORECASE
    )
    
    if new_content != content:
        with open(filepath, "w") as file:
            file.write(new_content)
        print(f"Updated {f}")

