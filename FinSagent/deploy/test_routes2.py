import sys, types
sys.path.insert(0, ".")

# Mock app module
mock_app = types.ModuleType("app")
mock_app.chat_service = None
sys.modules["app"] = mock_app

import memory_routes
router = memory_routes.router
print("memory_routes imported OK")
for r in router.routes:
    print("  %s %s" % (",".join(r.methods), r.path))
print("DONE")
