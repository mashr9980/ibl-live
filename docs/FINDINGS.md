# HeyGen LiveAvatar: what the open-source release is, and what it is not

Findings from building and deploying the ibl.ai live avatar, 11 to 14
September 2026. Everything below was verified by reading the code, calling
the APIs, or running sessions.

## Summary

HeyGen open-sourced client code, not an avatar engine. The repositories call
HeyGen's hosted LiveAvatar API for every frame of video and need a LiveAvatar
API key and a paid plan for anything beyond a short demo. Self-hosting is not
possible. The pricing is the same as for any LiveAvatar API user.

## What was released

Three repositories under github.com/heygen-com, all MIT licensed:

| Repository | What it is | Size |
| --- | --- | --- |
| liveavatar-gpt-live-demos | Demo: OpenAI GPT-Live drives a LiveAvatar face | about 3,000 lines of TypeScript, one dependency |
| liveavatar-sales-agent | Next.js app: an avatar that talks to website visitors | the base of my app |
| liveavatar-agent-skills | Instructions for coding agents to integrate LiveAvatar | text only |

None of them contain a model, model weights, or any machine learning code.
The only external hosts the demo code talks to are api.liveavatar.com and
api.openai.com. Its environment file requires LIVEAVATAR_API_KEY and
OPENAI_API_KEY.

The one model HeyGen did release the same week, TAVR, generates offline video
from a reference clip and needs a GPU with 80 GB of memory. It cannot run a
live conversation.

## The avatar service is the product

LiveAvatar is a separate HeyGen product with its own account, API key and
credits. HeyGen video credits do not apply. Every live session runs on
HeyGen's servers and is metered per minute.

| Plan | Price per month | Credits | Notes |
| --- | --- | --- | --- |
| Free | 0 | 10 | watermark, sessions capped at 120 seconds |
| Starter | 19 | 160 | |
| Pro / Essential | 99 | 1,010 | custom avatar slots can be bought only from this plan |
| Scale | 475 | 5,010 | |

FULL mode (LiveAvatar runs speech recognition, the language model and the
voice) costs 2 credits a minute. LITE mode (I bring the speech stack,
LiveAvatar renders the face) costs 1 credit a minute. Sandbox sessions are
free but limited to HeyGen's demo avatar and about one minute.

Measured on the free account used for the demo: 83 public avatars available,
0 custom avatar slots, session cap 120 seconds, and the 10 credits were used
up by the first day of testing (error 4033, "Insufficient credits for
session").

## Custom face and voice

A custom avatar (for example Mikel's face) is a paid add-on: HeyGen's FAQ
states that non-enterprise users need an active Essential plan before they
can buy an avatar slot. It is created from a two-minute video plus a consent
recording, or from a photo. Photo avatars from HeyGen's video product are not
usable in LiveAvatar.

Voice cloning is not part of the free tier either. I can clone a voice for
free through ElevenLabs, which I already use, and attach it to the
conversational agent.

## What I built

Repository: github.com/mashr9980/ibl-live. Deployed at
https://ibl-live.vercel.app.

- Base: HeyGen's liveavatar-sales-agent, with the persona, brain and copy
  replaced by me.
- Persona: "Ivy", an ibl.ai guide, written from the public ibl.ai pages,
  with guardrails tested against twelve questions designed to provoke
  invented facts.
- Brain: ibl.ai's OpenAI-compatible inference API by default. It was
  verified working, and switched to OpenAI for the demo because the ibl.ai
  tenant's balance was negative. Switching back is one setting.
- Speech-to-speech mode: an ElevenLabs conversational agent listens, thinks
  and speaks, with five ibl.ai pages as its knowledge base; LiveAvatar renders
  the face in LITE mode. This is what the demo runs.
- Verified in a real browser session: greeting by name, a spoken question
  transcribed, an answer spoken with lip-sync.
- When credits run out, the page shows "Out of free minutes" with a booking
  link instead of the raw error.

## Platform notes worth keeping

- ibl.ai's chat endpoint returns an internal error whenever max_tokens is
  sent, with any value.
- On the platform today, Gemini 3.1 Flash Lite and 3.5 Flash work; Gemini
  2.5 Flash, 2.5 Pro and the Claude models return an internal error.
- The ibl.ai hosting API requires a Vercel credential stored on the
  organization; mine has none, so I deployed the app to Vercel directly.

## Conclusion

The open-source release removes the work of writing a client, which took a
day here, but not the cost: the face is rendered by HeyGen's paid service at
the same prices as for everyone else. A public live avatar on ibl.ai with a
custom face needs at least the Essential plan plus an avatar slot, and
credits for every minute visitors talk to it.
