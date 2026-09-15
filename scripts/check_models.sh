#!/usr/bin/env bash
# Probe every model in the catalog: create session -> patch model -> prompt -> wait -> read reply.
set -u
P=9599
BASE=http://127.0.0.1:$P
MODELS=(
  opencode/muse-spark-1.2-contributor-free
  opencode/hy3-free
  opencode/x-preview-f-free
  opencode/deepseek-v4-flash-free
  opencode/kimi-k2-free
  opencode/qwen3-coder-free
  opencode/llama-3.3-70b-free
  anthropic/claude-sonnet-4
  anthropic/claude-opus-4
  anthropic/claude-haiku-4
  openai/gpt-5
  openai/gpt-5-mini
  openai/gpt-4.1
  google/gemini-2.5-pro
  google/gemini-2.5-flash
  ollama/qwen3:latest
  ollama/llama3.1:latest
)

echo "MODEL | promptHTTP | status | snippet"
for m in "${MODELS[@]}"; do
  RESP=$(curl -s -X POST "$BASE/session" -H "Content-Type: application/json" -d '{}')
  SID=$(echo "$RESP" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"//')
  PATCH=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/session/$SID" -H "Content-Type: application/json" -d "{\"model\":\"$m\"}")
  PROMPT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/session/$SID/prompt_async" -H "Content-Type: application/json" -d '{"parts":[{"id":"prt-1","type":"text","text":"Reply with exactly the word: PONG"}]}')
  sleep 4
  # read messages, look for assistant text or error
  MSGS=$(curl -s "$BASE/session/$SID/message?limit=10")
  # extract any error markers in assistant parts
  ERR=$(echo "$MSGS" | grep -o '"error":"[^"]*"' | head -1)
  TXT=$(echo "$MSGS" | grep -o '"text":"[^"]*"' | head -1 | sed 's/"text":"//;s/"$//')
  if [ -n "$ERR" ]; then STATUS="ERR:$ERR"; elif [ -n "$TXT" ]; then STATUS="OK"; else STATUS="no-reply"; fi
  SNIP=${TXT:0:40}
  echo "$m | patch=$PATCH prompt=$PROMPT | $STATUS | $SNIP"
  curl -s -X DELETE "$BASE/session/$SID" -o /dev/null
done
