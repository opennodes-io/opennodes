---
description: Price an AI task across providers before running it; you pick the option
argument-hint: <task, e.g. "summarise the 1,800 PDFs in ./contracts, EU only">
---

Quote this task with the `quote-before-run` skill: size it, collect the options with the OpenNodes tools, show the priced table with the data label for each option, and ask which one I want. Don't run anything yet.

Task: $ARGUMENTS

If no task is given, look at what we're working on in this session (code that calls an LLM API, a batch of files, an embedding step) and quote that. If there's nothing to quote, ask me what the task is.
