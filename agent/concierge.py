"""Venue concierge agent for Agentverse.

Answers questions like "where is quiet right now" or "how busy is food" by
forwarding them to the bridge's /api/ask endpoint, which runs Claude over the
live SpacetimeDB tables. The agent speaks the Agentverse chat protocol so it
shows up in ASI:One and the Agentverse chat UI.

Run:  python concierge.py
Env:  BRIDGE_URL (default http://localhost:8080), AGENT_SEED_PHRASE,
      AGENTVERSE_KEY (optional; enables mailbox registration)
"""

import os
from datetime import datetime, timezone
from uuid import uuid4

import httpx
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    TextContent,
    chat_protocol_spec,
)

BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://localhost:8080").rstrip("/")

agent = Agent(
    name="venue-concierge",
    seed=os.environ.get("AGENT_SEED_PHRASE", "venuemap concierge seed change me"),
    port=8001,
    mailbox=bool(os.environ.get("AGENTVERSE_KEY")),
)

chat = Protocol(spec=chat_protocol_spec)


def reply(text: str, end: bool = False) -> ChatMessage:
    content = [TextContent(type="text", text=text)]
    if end:
        content.append(EndSessionContent(type="end-session"))
    return ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(), content=content)


async def ask_bridge(question: str) -> str:
    async with httpx.AsyncClient(timeout=70) as client:
        r = await client.post(f"{BRIDGE_URL}/api/ask", json={"question": question})
    body = r.json()
    if r.status_code != 200:
        return body.get("error", "The venue map is not answering right now.")
    return body["answer"]


@chat.on_message(ChatMessage)
async def on_message(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    question = " ".join(c.text for c in msg.content if isinstance(c, TextContent)).strip()
    if not question:
        return
    try:
        answer = await ask_bridge(question)
    except Exception as e:  # network errors and bad JSON both end up here
        ctx.logger.warning(f"bridge call failed: {e}")
        answer = "The venue map is not answering right now. Try again in a minute."
    await ctx.send(sender, reply(answer))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    ctx.logger.debug(f"ack from {sender} for {msg.acknowledged_msg_id}")


agent.include(chat, publish_manifest=True)


@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"concierge address: {agent.address}")
    ctx.logger.info(f"bridge: {BRIDGE_URL}")


if __name__ == "__main__":
    agent.run()
