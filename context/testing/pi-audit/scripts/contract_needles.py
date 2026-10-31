#!/usr/bin/env python3
"""Find each pi-toolresult-guard contract needle anywhere in an installed pi.

    python3 contract_needles.py <node_modules/@earendil-works>

Prints, per needle, how many .js files contain it (whitespace-insensitive).
Answers "did the code change, or only move?" when the guard's pi-contract test
fails: on pi 1.4.0 needles 3-5 had only moved to another bundle chunk, while 2
and 6 had changed spelling (the test now accepts both forms).
"""
import os
import re
import sys

NEEDLES = {
    "1 getTextOutput": 'function getTextOutput(result,showImages){if(!result)return"";let textBlocks=result.content.filter(',
    "2 emitToolResult modified (<=0.87)": "if(modified)return{content:currentEvent.content,details:currentEvent.details,isError:currentEvent.isError,usage:currentEvent.usage}",
    "2 emitToolResult modified (>=0.99)": "if(modified)return{content:currentEvent.content,details:currentEvent.details,structuredContent:currentEvent.structuredContent,isError:currentEvent.isError,usage:currentEvent.usage}",
    "3a afterToolCall repair": "content=hookResult?.content??result.content??[]",
    "3b discard branch": "if(!(!hookResult&&normalizedContent===content))",
    "4 normalize by ref": 'async function normalizeToolResultImages(content,options){if(!content.some(block=>block.type==="image"))return content;',
    "5 merge": "result={...result,content:afterResult.content??result.content",
    "6 update bypass (<=0.87)": 'emit({type:"tool_execution_update",toolCallId:prepared.toolCall.id,toolName:prepared.toolCall.name,args:prepared.toolCall.arguments,partialResult})',
    "6 update bypass (>=0.99)": 'function emitToolExecutionUpdate(toolCall,emit){return partialResult=>emit({type:"tool_execution_update",toolCallId:toolCall.id,toolName:toolCall.name,args:toolCall.arguments,partialResult})',
}


def flat(s: str) -> str:
    return re.sub(r"\s+", "", s)


root = sys.argv[1]
texts = {}
for d, _, fs in os.walk(root):
    for f in fs:
        if f.endswith(".js"):
            path = os.path.join(d, f)
            with open(path, encoding="utf8", errors="replace") as fh:
                texts[path] = flat(fh.read())
for label, needle in NEEDLES.items():
    hits = [os.path.relpath(p, root) for p, t in texts.items() if flat(needle) in t]
    print(f"{label:38s} {len(hits)} {hits[:3]}")
