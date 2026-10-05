"""Single A2A call to a LibreChat agent served at /api/a2a/agents/<agent_id>.

Requires `a2aSettings.server.enabled: true` in librechat.yaml and an Agent API key
whose owner has remote access to the agent.

    LIBRECHAT_API_KEY=sk-... python3 a2a_call_example.py
    LIBRECHAT_API_KEY=sk-... A2A_AGENT_ID=agent_xxx python3 a2a_call_example.py "Hello"
"""

import json
import os
import sys
import urllib.request
import uuid

BASE_URL = os.environ.get("LIBRECHAT_URL", "http://localhost:3080")
AGENT_ID = os.environ.get("A2A_AGENT_ID", "agent_VnqJycN9klRqX9eYp7GB5")
API_KEY = os.environ["LIBRECHAT_API_KEY"]
TEXT = sys.argv[1] if len(sys.argv) > 1 else "Lancia un dado da 20"

payload = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
        "message": {
            "kind": "message",
            "role": "user",
            "messageId": str(uuid.uuid4()),
            "parts": [{"kind": "text", "text": TEXT}],
        }
    },
}

req = urllib.request.Request(
    f"{BASE_URL}/api/a2a/agents/{AGENT_ID}",
    data=json.dumps(payload).encode(),
    headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=300) as res:
    task = json.load(res)["result"]

print("stato:", task["status"]["state"])
for artifact in task.get("artifacts", []):
    for part in artifact["parts"]:
        print(part.get("text", ""))
