# Venue concierge (Fetch.ai uAgent)

A chat-protocol agent that answers "where is quiet", "how busy is food", "where is team lagoon" by calling the bridge's `/api/ask`, so the same Claude-over-SpacetimeDB answer is reachable from ASI:One and the Agentverse chat.

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
BRIDGE_URL=http://localhost:8080 python concierge.py
```

The address is printed at startup. With `AGENTVERSE_KEY` set the agent registers through the Agentverse mailbox and can be found from the Agentverse UI; without it, it runs locally on port 8001 and can be messaged by another local agent.

The agent is only useful when the bridge is running with `ANTHROPIC_API_KEY` set. Without the key the bridge still runs, but every answer is its "Ask is off" message.
