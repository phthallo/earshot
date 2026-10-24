# Venue concierge (Fetch.ai uAgent)

A chat-protocol agent that answers "where is quiet", "how busy is food", "where is team lagoon" by calling the bridge's `/api/ask`, so the same Claude-over-SpacetimeDB answer is reachable from ASI:One and the Agentverse chat.

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
BRIDGE_URL=http://localhost:8080 python concierge.py
```

The address is printed at startup. With `AGENTVERSE_KEY` set the agent registers through the Agentverse mailbox and can be found from the Agentverse UI; without it, it runs locally on port 8001 and can be messaged by another local agent.

The bridge must be running with `ANTHROPIC_API_KEY` set, or every answer is the bridge's "Ask is off" message.
