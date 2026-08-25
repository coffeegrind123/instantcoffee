# The VRAM floor is the Windows desktop, and it can be measured without stopping llama

*2026-08-23. Supersedes the "other tenants" language in `versions.lock`'s
`vram_note` and closes the decisive unknown that job 3 of the quiet-box handoff
was waiting on. Extended the same afternoon with §5a, the in-use floor — which
is what finally closes 128K, on the very terms the follow-up handoff set for
re-opening it.*

Every context-window decision this repo has made was made against a number
nobody had measured. `nvidia-smi` reports the **device**, and something on this
card holds 1.4-2.0 GiB that is not llama. 128K was refused because at the top of
that range it would leave 96 MiB. This document is what that something actually
is, how to measure it in one command, and what it does to the 128K question.

## 1. What was wrong with the old method

The floor was measured by **stopping llama and reading `nvidia-smi`**:

```sh
docker compose stop llama
docker run --rm --gpus all --entrypoint nvidia-smi \
  ghcr.io/ggml-org/llama.cpp:server-cuda-b10573 \
  --query-gpu=memory.used,memory.total --format=csv,noheader
```

Three things are wrong with it, and they compound:

- **It costs a 15-20 minute cold reload** (`--load-mode none`, 17.5 GB over a 9p
  mount), so nobody does it more than once per session.
- **It is one sample**, taken at whatever the desktop happened to be doing that
  minute. Across one morning it produced 1,405 / 1,536 / 1,881 / 1,905 / 1,961 /
  2,027 MiB — a 622 MiB range with no way to know where in it a decision sits.
- **It attributes nothing.** "Something holds 1.9 GiB" does not tell you whether
  closing a browser would fix it.

And the obvious next step does not work. `nvidia-smi --query-compute-apps` on the
host **names** the processes and returns `[N/A]` for every `used_gpu_memory`,
because per-process attribution is not available under Windows' WDDM driver
model:

```
pid, process_name, used_gpu_memory [MiB]
6720, C:\Windows\explorer.exe, [N/A]
9156, C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe, [N/A]
...
```

That `[N/A]` is where the previous session stopped, and it is why the handoff
recorded the floor as an unknown rather than as a fact.

## 2. Windows' own counters do decompose it

The GPU performance counters are not subject to that limitation:

```
\GPU Adapter Memory(*)\Dedicated Usage    whole device, per adapter
\GPU Process Memory(*)\Dedicated Usage    per process, instance name carries the pid
```

`vmwp` is the Hyper-V worker process hosting the WSL2 / Docker Desktop VM.
**`instantcoffee-llama` is the only GPU-enabled container on this box** — re-checked this
session across all 17 running containers' `HostConfig.DeviceRequests`, and one
of them (`xgb-daemon`, image `tennis-xgboost-gpu`) is named as though it were a
counter-example and is not: no devices, not privileged, and no `/dev/dxg`
inside it. Verify that before trusting any of this, because it is the single
assumption the whole subtraction rests on. So `vmwp`'s dedicated
usage *is* llama's, and:

```
   floor  =  adapter total  -  vmwp
```

`scripts/vram-floor.sh` samples both every 15 s for 15 minutes and reports the
distribution. llama is never touched.

## 3. Both halves were controlled before being believed

This is the part that matters, because a plausible-looking counter that measures
something *else* would have produced a confident wrong answer — and the failure
mode of this whole class is silence.

**Control 1 — are the counters even in VRAM units?** Read the adapter counter and
`nvidia-smi` at the same moment:

```
   \GPU Adapter Memory  23,099.8 MB
   nvidia-smi           23,088    MiB
```

Agreement within 12 MiB. The counters are real VRAM, not a commit-charge
abstraction.

**Control 2 — is the subtraction valid?** It is only valid if all the variation
is on the desktop side. Consecutive paired samples:

```
   time      device      vmwp      floor
   10:42:32  23112.8   21677.4    1435.4
   10:42:49  23111.2   21677.4    1433.8
   10:43:06  23083.6   21677.4    1406.2
```

`vmwp` is **byte-identical across samples** while the total moves. llama's
allocation does not breathe; the desktop's does. That is what licenses the
subtraction, and it also means the floor can be watched continuously in
production.

**The trap, recorded so nobody re-walks it:** *do not sum the per-process
counters.* They double-count — `dwm` maps every other window's surface, so it
reports ~4,751 MB and the per-process column sums to **27,800 MB on a 24,564 MiB
device**. Only the adapter total is additive. A first pass at this read `dwm`'s
4.7 GB as a finding ("the compositor is eating a fifth of the card") and it is
an artefact.

## 4. What is actually holding it

Per-process dedicated usage, MiB, biggest first, with the aliasing caveat above:

```
   27880  21677.4  vmwp                 <- the VM: llama. Not the desktop.
    2080   4751.4  dwm                  <- compositor, largely ALIASED surfaces
    9156    199.1  brave
   21232    193.3  chrome
   20248    172.0  WindowsTerminal
    6720    146.7  explorer
    1444    112.2  csrss
   19120     94.8  Discord
   23672     76.3  Docker Desktop
   16220     62.3  claude (desktop app)
   18568     61.9  VSCodium
   16008     52.9  steamwebhelper
   32832     41.4  msedgewebview2
   13384     30.8  TextInputHost
    2636     26.6  Voicemod
   ... 7 more under 27 MiB each
```

**This refutes the handoff's optimistic branch.** It hoped the floor might be
"a browser or something closable", in which case 128K would gain ~1.5 GiB of
margin. It is not. The floor is roughly twenty ordinary desktop processes, the
largest closable one is a browser at ~200 MB, and the biggest single line is a
compositor that cannot be closed at all.

**How much closing things would actually recover is NOT known from this table,
and cannot be** — the same aliasing that inflates `dwm` means a per-process
figure is an upper bound on what freeing that process returns to the device.
The honest statement is bounded from both ends: the entire floor is 1,406 MiB
and the unclosable part of it (compositor, csrss, explorer, the shell hosts,
Docker Desktop itself) is most of the list, so the recoverable amount is
somewhere between "a little" and "a few hundred MiB". Neither end changes the
128K answer, which is why this was not pursued further.

If it ever matters, the experiment is cheap and definitive now: close them and
re-run `./scripts/vram-floor.sh`. Measure the delta on the ADAPTER counter,
which is the only additive one. Do not compute it by summing per-process
values — that is the mistake this section exists to prevent.

## 5. Measured floor, and what it leaves

15-minute capture, 47 paired samples, desktop idle:

```
                                  min     median        max
   device total (MiB)         23050.0          -    23112.8
   llama, via vmwp (MiB)      21677.4          -    21677.4
   WINDOWS HOST FLOOR (MiB)    1372.6     1406.3     1435.4
```

llama moved **0.0 MiB** across the capture — not "about zero", exactly zero, the
same 21677.4 in all 47 samples. The floor moved 62.8 MiB, all of it desktop.

**Three instruments, three methods, one answer.** This is the part that makes it
safe to build on:

```
   Windows perf counters, adapter - vmwp, 47 samples   1372.6 / 1406.3 / 1435.4
   plain nvidia-smi on the host, 59 samples            1376   / 1405   / 1442
   the OLD method: stop llama, nvidia-smi in-container       1381
```

The third is `capacity-probe.sh`'s own idle-floor step, taken minutes later — it
really does stop llama, so it shares no mechanism at all with the other two, and
it lands inside their range.

A fourth check falls out of the same probe run, from the other direction. With
llama back up at 96K it read the whole device at 23,019 MiB against that 1,381
floor, i.e. a llama footprint of **21,638 MiB** — against the **21,677.4** the
perf counter reports for `vmwp`. A 39 MiB difference, which is inside the ~50
MiB resolution limit `capacity-probe.sh`'s own header states for sampled VRAM.
So the two methods agree on llama's size as well as on the desktop's.

Note where that median lands: **1,405 MiB is exactly the LOWEST of the six
values ever recorded by the old stop-llama method** (1,405 / 1,536 / 1,881 /
1,905 / 1,961 / 2,027). An idle desktop sits at the bottom of the historical
range, which is both a consistency check and a warning about what this capture
does and does not cover.

**Read this as an IDLE-DESKTOP figure, not as the worst case.** It says the floor
is remarkably stable *while nothing is happening*; it does not repeal the 2,027
MiB seen across an active morning. Both ends matter below.

## 5a. The same measurement on a WORKING desktop, 2026-08-23 afternoon

The section above ends by saying the idle capture covers one end of the range and
the other end is what decisions are refused against. So the other end was
measured, with the same instrument and llama untouched:

```
   ./scripts/vram-floor.sh --label active --samples 90 --interval 20

                                  min     median        max
   device total (MiB)         23155.3          -    23194.9
   llama, via vmwp (MiB)      21677.4          -    21677.4
   WINDOWS HOST FLOOR (MiB)    1477.9     1500.8     1517.5
```

`--label` exists because a capture overwrites its CSV and the whole point of the
second one is to sit beside the first. Both are checked in:
`vram-floor.csv` (idle, 47 samples) and `vram-floor-active.csv` (90 samples).

**The two captures do not overlap.** The active minimum, 1,477.9, is 42 MiB above
the idle maximum, 1,435.4. There is clear air between them, so the difference is
the desktop being used and not sampling noise — and `vmwp` again read exactly
21,677.4 in all 90 samples, so none of it is llama.

**What the desktop was actually doing, so this is interpretable later.** Taken
from the same perf counters at the end of the capture, biggest first, `dwm`
excluded because it maps every other window's surface and double-counts:

```
   explorer 195, WindowsTerminal 172, chrome 169, Discord 161, brave 138,
   csrss 125, Docker Desktop 75, claude 75, steamwebhelper 65, VSCodium 55,
   msedgewebview2 44, TextInputHost 31, Voicemod 31, SearchHost 26, ...
```

That is a **normally-populated working desktop** — browsers, chat, a terminal, an
editor, Steam signed in — with **nothing GPU-heavy in the foreground**. The floor
moved only 39.6 MiB across the whole half hour, which is the signature of a
steady set of open windows rather than of applications being launched and closed.

**So this is the ORDINARY case, not the worst one.** The 2,027 MiB the old method
once recorded is still the worst observed and is still unexplained by anything
here; a game or a video call would plausibly reach it. What this capture settles
is the far more common question — what the floor is while the box is simply being
used — and the answer is **~1,500 MiB, about 95 MiB above idle**.

## 6. The 128K arithmetic, and why it is now a refusal on evidence

The engine's own `-lv 5` table gives the 96K -> 128K delta as **+1,408 MiB**
(20,426 -> 21,834 CUDA0). That number is solid; a sampled delta once got the same
comparison wrong by 1,163 MiB. So:

```
   free at 128K  =  24,564  -  (device total at 96K  +  1,408)
```

| desktop state | floor | free at 128K |
|---|---:|---:|
| idle, median of 47 samples | 1,406 | **72 MiB** |
| idle, best single sample | 1,373 | 106 MiB |
| idle, worst single sample | 1,435 | 43 MiB |
| **in use, median of 90 samples** | **1,501** | **-22 MiB** |
| in use, best single sample | 1,478 | 1 MiB |
| in use, worst single sample | 1,518 | -39 MiB |
| active, worst ever observed | 2,027 | **-548 MiB** |

**There is no draft-KV rescue column, and the handoff's version of this table
had one.** It assumed `-ctkd/-ctvd q8_0` would give back ~240 MiB at 128K. It
was measured the same day this document was written and it does the opposite:
it saves 240 MiB of draft KV and spends ~524 MiB of draft compute buffer, for a
net **cost** of ~284 MiB. At 128K that takes the idle case from 72 MiB to about
**-212**. See `draft_kv_note` in `versions.lock`; the mechanism is that
quantising the MTP head's KV drops the draft context off its small specialised
graph onto a workspace exactly the size of the main context's.

**The in-use rows are the ones that settle it, and they were added on 2026-08-23
precisely to test the escape hatch the previous handoff left open.** That handoff
said: if the active floor turns out to be ~1.5 GiB rather than the 2,027 MiB
worst case, 128K is worth one more look. The active floor was then measured and
it *is* ~1.5 GiB — 1,500.8 MiB median. So the look happened, on the terms it was
asked for, and the answer is still no: at that floor 128K is **-22 MiB**. It does
not fit while the box is merely being used, let alone at the worst case.

That is a stronger refusal than the one it replaces. 128K was previously refused
against 2,027 MiB — a single value from the old one-sample method that nothing
since has reproduced, and which an optimist could dismiss as unrepresentative.
It is now refused against the ORDINARY state of the machine, sampled 90 times,
by an instrument whose agreement with two others is shown in §3.

The idle row is what makes this worth spelling out: 128K "fits" at idle with
72 MiB to spare, and that 72 MiB is entirely consumed by opening the windows the
operator normally has open. A configuration that fits only while nobody is using
the computer does not fit.

The remaining rows still hold. At the worst desktop state this box has actually
been in, **128K does not fit at all** — it would fail to allocate, not merely run
thin. Note that the whole idle spread, best sample to worst, is 43-106 MiB: every
point of it is inside the noise of a single allocation.

**128K got further away today, not closer.** The handoff's third scenario had
draft-KV q8_0 plus a lower floor arriving at ~1,860 MiB free. Both halves of it
are now measured and both go the wrong way: the floor does not drop to ~500
because it is twenty small processes rather than one big one, and the draft-KV
lever costs VRAM rather than returning it.

**128K stays refused, and the reason has changed.** It was refused on an
unmeasured desktop and a 96 MiB estimate; it is now refused on a measured floor
whose worst observed value makes the configuration impossible. The handoff's
third scenario — "floor at ~500 MiB with draft q8_0 gives ~1,860 MiB free" —
requires a floor this box has never been near.

96K keeps ~1,480 MiB free at the measured idle floor, ~1,386 MiB free at the
measured in-use floor, and survives the 2,027 case with ~860 MiB. It has real
headroom in every state this box has been observed in, which is exactly what
128K does not have in any of them. That is the window this stack should stay on.

## 7. The lever that was not a lever, and how it hid

The same session that measured the floor also re-ran the one open VRAM lever,
and it turned out to be a regression. It is documented here rather than
separately because it is the same failure as §3's `dwm` trap: **a number read
one line deep.**

The MTP draft context runs F16 KV while the main context runs q8_0, because
`--spec-draft-type-k`/`-ctkd` and `-ctvd` default to F16 and `docker-compose.yml`
never set them. Setting both to q8_0 was recorded as "~180 MiB sitting there,
engine-confirmed at `-lv 5`, not inferred". The engine confirmation was real:

```
   f16 control   llama_kv_cache: size = 384.00 MiB (98304 cells, 1 layers), K (f16): 192.00, V (f16): 192.00
   q8_0 arm      llama_kv_cache: size = 204.00 MiB (98304 cells, 1 layers), K (q8_0): 102.00, V (q8_0): 102.00
```

180 MiB, exactly as advertised. **The line nobody read is the next one.** The
full CUDA0 allocation, both arms, 96K:

| CUDA0 buffer | f16 control | q8_0 arm | delta |
|---|---:|---:|---:|
| model | 16,053.22 | 16,053.22 | — |
| main KV | 3,264.00 | 3,264.00 | — |
| RS | 748.12 | 748.12 | — |
| main compute | 560.28 | 560.28 | — |
| draft KV | 384.00 | 204.00 | **-180.00** |
| draft compute | 164.02 | **560.28** | **+396.26** |
| **total** | **21,173.64** | **21,389.90** | **+216.26** |

**Look at what the draft compute buffer becomes: 560.28 — exactly the main
context's.** Quantising the MTP head's KV drops the draft context off its small
specialised graph onto a full-width workspace. The saving is real and the cost
is more than double it.

The same thing is visible in the ORIGINAL 2026-08-22 logs, at 64K, kept as
`draftkv-*-contended.log`: draft KV 256 -> 136 (-120), draft compute 132.02 ->
400.28 (+268.26), net +148.26. **The evidence that refutes the lever was on disk
from the day it was proposed.**

And sampled whole-device VRAM agreed with the engine the whole time: 23,019 ->
23,233 at 96K, i.e. **+214 against the engine's +216**. The two instruments were
never in conflict. The previous session recorded a conflict between them because
it was comparing a sampled TOTAL against an engine SUBTOTAL.

**Decode was never the problem**, which is why VRAM is the whole story. Re-run
at 96K on an acceptable box:

```
   control  176.4 tok/s  spread 12.2%  draft/cycle 24.89
   q8_0     174.4 tok/s  spread 10.9%  draft/cycle 24.39
```

Within noise on every axis, and both arms under the 15% spread gate. The lever
passes every acceptance criterion the handoff wrote for it **and must still be
rejected**, because the criteria were about decode and the defect is in VRAM.
That is worth keeping: a set of acceptance criteria is only as good as its
coverage of the ways the thing can be wrong.

**Verdict: do not set `-ctkd`/`-ctvd`.** Leave the draft cache at F16.

## 8. What to do with this next

- `./scripts/vram-floor.sh` — 15 minutes, no reload, no llama restart. Use
  `--label <name>` for anything you want to keep beside an existing capture; a
  run without one overwrites `vram-floor.csv`.
- **The idle and in-use floors are now both measured** (§5, §5a) and they do not
  overlap: 1,373-1,435 idle, 1,478-1,518 in use. 128K is refused against the
  second, which is the ordinary state of the machine.
- **What is still unmeasured is a GPU-HEAVY foreground** — a game, a video call,
  anything that puts a real renderer on the card. The 2,027 MiB the old method
  recorded once has never been reproduced, and until something does reproduce it
  the top of the range rests on a single sample from the method this document
  exists to replace. It changes no decision — 128K is already refused 95 MiB
  lower down — so this is provenance, not a blocker.
- The bridge must be running. `~/.claude-host-bridge-token` **existing does not
  mean the bridge is up** — that assumption cost a session. The script probes
  port 6799 and treats a 401 as healthy (a running bridge refusing an
  unauthenticated request).
