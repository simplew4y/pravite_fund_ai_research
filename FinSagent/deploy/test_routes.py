import sys
sys.path.insert(0, ".")
import app
print("app imported OK")
for r in app.app.routes:
    p = getattr(r, "path", "")
    if "/memory" in p:
        print(" ", ",".join(getattr(r, "methods", set())), p)
