# Build and polish with Claude Code

Open the project folder in VS Code, open the integrated terminal and run `claude` (install first with `npm install -g @anthropic-ai/claude-code` if needed). `CLAUDE.md` in the project root is read automatically. Give Claude Code **one prompt at a time**, and after each one run `npm test && npm run build`.

## 0. First session: get it running and prove it
```
Read CLAUDE.md, README.md and docs/NEXT_PHASES.md. Run npm install, npm run typecheck, npx vitest run, node tests/migration.test.mjs and npm run build, and tell me the result of each. Then start npm run dev and open http://localhost:1420 in a browser. Create a farm, sign in, and walk through every sidebar page once. Take a screenshot of each page at desktop width (1440px) and phone width (390px). Do NOT change code yet: give me a ranked list of visual and usability problems you actually saw (layout breaks, overflow, unreadable tables, missing empty states, unclear labels, inconsistent spacing or buttons), with the page and the screenshot for each.
```

## 1. Visual polish pass (do this before adding features)
```
Using your list from the first session, fix the problems in priority order. Rules: reuse src/ui/kit.tsx components and extend them rather than styling pages one by one; keep Tailwind; make every page usable at 390px width (tables scroll inside their card, forms stack, modals fit); give every list an empty state with a clear next action; make buttons, spacing, headings and badge colours consistent; check keyboard focus rings and colour contrast; do not change behaviour or text that tests rely on, and update tests only when a label legitimately changes. Add a light/dark-safe colour system only if it does not touch business logic. After each group of fixes re-screenshot the affected pages. Finish with the full check suite and a short before/after summary.
```

## 2. Onboarding and first-run experience
```
A new farm owner should get from install to first harvest record in under 10 minutes. Review the create-farm, sign-in, empty dashboard and first-season flows and improve them: a short checklist on the dashboard (create season, add fields, add inputs, record rain, record first harvest) that ticks itself off from real data, sensible defaults, plain-language help text under confusing fields, and clear error messages. Keep it offline-friendly. Add a jsdom UI test that walks the checklist.
```

## 3. Measure the local model (run this on the office PC)
```
Start Ollama and pull qwen2.5:3b-instruct. Run: npx tsx tools/brain-bench/bench.ts --url http://127.0.0.1:11434 --model qwen2.5:3b-instruct. Paste me the whole output. Based on the numbers, recommend whether to keep model wording off, whether a different or smaller model would do better (try qwen2.5:1.5b-instruct and llama3.2:3b), and tune the router prompt in src/brain/engine.ts if routing accuracy is below the keyword floor. Re-run the benchmark after each change and keep a table of results in docs/BRAIN_ARCHITECTURE.md.
```

## 4. Model launcher (so users never touch a terminal)
```
Design and build a Tauri integration that starts and stops a local llama.cpp server for the brain: detect RAM and recommend a model size, download the chosen GGUF to the app data folder with progress and checksum verification, start the server on 127.0.0.1 on a free port with CORS limited to the app origin, stop it on exit, and expose status to src/pages/Brain.tsx (Engine settings). Keep all rules in TypeScript with Rust as a thin shell, like src-tauri/src/hub.rs, and add a compile-test harness like tools/hub-harness. Ask me before choosing the model source and licence.
```

## 5. Verify the Wi-Fi hub on real devices
```
Walk me through testing the Wi-Fi hub with the office PC and one Android phone: what to install, how to find the PC's address, how to pair, and what to check. Then fix whatever breaks. Known open items: Android cleartext HTTP / Tauri HTTP plugin, hub log pruning, firewall prompts on Windows. Add any fixes with tests; update README and docs.
```

## 6. Real desktop packaging
```
Run npm run tauri build on this machine. Fix packaging problems, set the app name, version, identifier and icons, make persistence use a native database file instead of IndexedDB if feasible without changing the Db API (keep a one-time import from IndexedDB), and add an automatic local backup before every schema upgrade. Document the installer steps for Windows.
```

## 7. Business brain next layers (pick one per session)
- **Photos and voice notes (L2):** `Read docs/BRAIN_ARCHITECTURE.md. Build Layer 2: photos and voice recordings attached to notes and events, stored locally, synced via Supabase Storage with RLS, optional on-device transcription (whisper.cpp) and optional Claude vision description behind brain.chat.cloud. Follow every rule in CLAUDE.md, add a migration, tests, and README notes.`
- **Confirm-first actions (L5):** `Build Layer 5: the brain may propose a structured entry (for example log rainfall) from a chat message; the person sees it, edits it and confirms; execution calls the normal service functions under their own permissions. A new permission brain.chat.act gates it. Never execute without confirmation. Add tests for permission, validation and cancel.`
- **More catalogue lookups:** `Add 10 more lookups to src/brain/catalogue.ts for questions a Zimbabwean tobacco farmer would ask (cost per kg sold, yield per ha by variety, curing fuel per kg, grade mix, payments received, contract advances outstanding...). For each add keywords, tests, and questions to src/brain/evalset.ts; keep the unseen HOLDOUT_SET untouched and report the results.`

## 8. Hardening before real farms use it
```
Do a security and data-integrity review as a sceptical engineer: RLS policies and migrations, role/permission checks in every service, the Wi-Fi hub (pairing, tokens, write allow-list), the local model endpoint, API key storage, backup/restore, and sync conflict handling. List concrete risks with file references, fix the high ones with tests, and give me the rest as a ranked list.
```
