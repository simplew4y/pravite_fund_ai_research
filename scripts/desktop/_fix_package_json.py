#!/usr/bin/env python3
import json
from pathlib import Path

p = Path(__file__).resolve().parents[2] / "omnigent" / "web" / "electron" / "package.json"
data = json.loads(p.read_text(encoding="utf-8"))
data["productName"] = "私募研究工作台"
build = data.setdefault("build", {})
build["appId"] = "ai.privatefund.workbench"
build["productName"] = "私募研究工作台"
build["files"] = [
    "src/**/*",
    "setup/**/*",
    "find/**/*",
    "icons/**/*",
    "boot/**/*",
]
build["extraResources"] = [
    {
        "from": "../platform-assets",
        "to": "platform-assets",
        "filter": ["**/*"],
    },
    {
        "from": "resources/runtime",
        "to": "runtime",
        "filter": ["**/*"],
    },
]
win = build.setdefault("win", {})
win["target"] = ["nsis"]
win["icon"] = "icons/icon.ico"
build["nsis"] = {
    "oneClick": False,
    "allowToChangeInstallationDirectory": True,
    "artifactName": "PrivateFundWorkbench-Setup-${version}-${arch}.${ext}",
}
p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("OK", build["nsis"]["artifactName"])
