# Meld

### Describe an app. Keep what works. Make it yours.

Meld turns an app idea into a proposed product, a reviewable design, and a working Android app. Start from a real **base app**, select useful ideas from reference apps, and shape the result around your users.

**Idea → Find references → Propose improvements → Review the design → Build and try the app**

- **A familiar starting point.** Base-app screenshots guide the layout, hierarchy and visual language, so the design has a concrete foundation.
- **Focused improvements.** Review which features to keep, adapt or add. Reference attribution is separate from a claim that a feature is new.
- **An editable product proposal.** Adjust the feature choices and design before building; saved versions let you revisit decisions.
- **An app you can use.** Download the Android APK or interact with it in the website's Android preview. Build and test reports accompany the result; these demos also include device checks.

## Demo 1 · Focus Grove

**A tree-growing study timer with task-linked focus.**

[![Watch Forest and Focus Grove side by side](frontend/public/demos/focus-grove-preview.gif)](frontend/public/demos/focus-grove.mp4)

[▶ Watch the comparison video](frontend/public/demos/focus-grove.mp4) · [Screenshots and verification](docs/focus-grove-example.md) · [Android source](examples/focus-grove/)

| | Product choice |
| --- | --- |
| **Base: [Forest](https://www.forestapp.cc/)** | Keep the plant → focus → grow → collect loop, central circular tree scene and forest overview. |
| **Reference: Focus To-Do** | Adapt an editable task list and associate completed focus time with the selected study task. |
| **References: Tide, Loop, Focusmeter** | Inform local sound controls, a custom daily focus-minute target and progress by task. |
| **Our proposed adaptation** | A lightweight study workflow: choose a task, grow a tree, complete the task and review its focus minutes alongside a daily target. |

**What the video distinguishes:** tree growth, environment sounds, tags/analytics and streaks overlap with Forest's own capabilities. The task-list workflow and the particular integration are the adaptation; sounds and statistics are **not** presented as features Forest lacks. Forest is shown using its store UI references; Focus Grove footage comes from the actual generated APK. The current artwork is simpler than Forest's.

## Demo 2 · Pocket Ledger

**A daily expense tracker that lets you try a purchase before recording it.**

[![Watch Cashew and Pocket Ledger side by side](frontend/public/demos/pocket-ledger-preview.gif)](frontend/public/demos/pocket-ledger.mp4)

[▶ Watch the comparison video](frontend/public/demos/pocket-ledger.mp4) · [Screenshots and verification](docs/pocket-ledger-example.md) · [Android source](examples/pocket-ledger/)

| | Product choice |
| --- | --- |
| **Base: [Cashew](https://github.com/jameskokoska/Cashew)** | Keep a money-first overview, rounded pastel cards, category budgets, transaction entry and spending history. |
| **Reference: Money Manager** | Use calendar day drill-down as an interaction reference for finding and editing transactions. |
| **Reference: Wallet** | Use explicit spent, remaining and over-budget breakdowns to make budget tradeoffs easier to read. |
| **Our proposed workflow** | **Try a purchase:** compare the current and projected category balance and daily allowance, without changing the ledger. Cancel safely, or explicitly record the purchase once. |

Cashew already has budgets, calendar views, scheduled transactions and daily spending allowance. Those are the foundation, not claimed additions. The demo emphasizes the **non-destructive preview → comparison → explicit recording** workflow. Both sides use actual APK footage; Cashew's own demo mode supplies its sample records. This is a focused offline USD demo, without bank connections or cloud sync.

## Try it

With Node 24, JDK 17+ and Android SDK 35 available:

```bash
npm run dev
```

Open **http://127.0.0.1:4173**. The delivery workspace offers both saved examples and [comparison videos](http://127.0.0.1:4173/demos/index.html). Generating new apps requires model configuration; saved project data and APKs are local artifacts, so a fresh clone does not contain the delivered example sessions.

[Setup](frontend/README.md) · [Architecture and workflow](docs/project-workflow.md) · [Design and coding skills](docs/ui-coding-skills.md) · [Market scanner](docs/market-scanner.md) · [Demo sources](docs/demos/README.md)
