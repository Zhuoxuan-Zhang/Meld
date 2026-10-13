(() => {
  const config = JSON.parse(document.getElementById("demo-config").textContent);
  const key =
    "meld.output." +
    config.name +
    "." +
    config.features.map((f) => f.id).join("-");
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(key) || "{}") || {};
  } catch {}
  const base = {
    tasks: [],
    notes: [],
    habits: [],
    journal: [],
    workouts: [],
    goals: [],
    flashcards: [],
    reading: [],
    expenses: [],
    boards: [],
    bookmarks: [],
    budget: 0,
    garden: 0,
  };
  const state = Object.fromEntries(
    Object.entries(base).map(([k, v]) => [
      k,
      Array.isArray(v)
        ? Array.isArray(saved[k])
          ? saved[k]
          : []
        : typeof saved[k] === "number" && Number.isFinite(saved[k])
          ? saved[k]
          : v,
    ]),
  );
  let active = config.features[0]?.id,
    timer = null,
    deadline = 0,
    remaining = 25 * 60,
    breathing = null,
    cardIndex = 0,
    flipped = false,
    editingNote = null;
  const root = document.getElementById("demo-root");
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") node.textContent = v;
      else if (k.startsWith("on"))
        node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v);
    }
    for (const child of children) node.append(child);
    return node;
  };
  const text = (tag, value, cls = "") => el(tag, { text: value, class: cls });
  const button = (label, action, cls = "", extra = {}) =>
    el("button", {
      text: label,
      onClick: action,
      class: cls,
      type: "button",
      ...extra,
    });
  const input = (placeholder, type = "text", value = "") =>
    el("input", {
      placeholder,
      type,
      value,
      "aria-label": placeholder,
      ...(type === "text" ? { maxlength: "600" } : {}),
    });
  const store = () => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {}
  };
  const uid = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const add = (k, obj) => {
    state[k].push({ id: uid(), ...obj });
    store();
    render();
  };
  const remove = (k, id) => {
    if (k === "notes" && editingNote === id) editingNote = null;
    state[k] = state[k].filter((x) => x.id !== id);
    store();
    render();
  };
  const sum = () =>
    state.expenses.reduce((s, x) => s + Number(x.amount || 0), 0);
  const money = (n) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(n);
  const safeUrl = (s) => {
    try {
      const u = new URL(s);
      return ["https:", "http:"].includes(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  };
  function render() {
    if (breathing) {
      clearInterval(breathing);
      breathing = null;
    }
    root.replaceChildren();
    const shell = el("div", { class: "shell" });
    root.append(shell);
    shell.append(
      text("div", "MADE WITH MELD · INTERACTIVE DEMO", "eyebrow"),
      text("h1", config.name),
      text(
        "p",
        config.description ||
          "A little focus. A little progress. All in one place.",
        "muted",
      ),
    );
    const nav = el("nav", { class: "nav", "aria-label": "App features" });
    config.features.forEach((f) =>
      nav.append(
        button(
          f.name,
          () => {
            active = f.id;
            render();
          },
          "",
          { "aria-pressed": String(active === f.id) },
        ),
      ),
    );
    shell.append(nav);
    const feature = config.features.find((f) => f.id === active);
    if (!feature) return;
    const panel = el("section", { class: "panel", "aria-label": feature.name });
    shell.append(panel);
    panel.append(
      text("h2", feature.name),
      text("p", feature.description, "muted"),
    );
    const error = text("p", "", "error");
    error.setAttribute("role", "status");
    const fail = (m) => {
      error.textContent = m;
    };
    const empty = (message) => text("div", message, "empty");
    const list = (k, build) => {
      const wrap = el("div", { class: "items" });
      if (!state[k].length)
        wrap.append(empty("Nothing here yet. Add your first one above."));
      state[k].forEach((item) => wrap.append(build(item)));
      panel.append(wrap);
    };
    const deleteButton = (k, item) =>
      button("Remove", () => remove(k, item.id), "", {
        "aria-label": `Remove ${item.title || item.text || item.question || "entry"}`,
      });
    if (active === "timer") {
      const face = el("div", { class: "timer" }, [
        text("span", "", "digits"),
        text("small", "A MOMENT TO FOCUS"),
      ]);
      panel.append(face);
      const duration = input(
        "Minutes",
        "number",
        String(Math.round(remaining / 60) || 25),
      );
      duration.min = "1";
      duration.max = "180";
      const start = button(
        timer ? "Pause" : "Start focus",
        () => {
          if (timer) {
            remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            clearInterval(timer);
            timer = null;
          } else {
            if (remaining <= 0) remaining = 25 * 60;
            deadline = Date.now() + remaining * 1000;
            timer = setInterval(tick, 250);
          }
          render();
        },
        "primary",
      );
      panel.append(
        el("div", { class: "center" }, [
          el("div", { class: "row" }, [
            start,
            button("Reset", () => {
              clearInterval(timer);
              timer = null;
              remaining = 25 * 60;
              render();
            }),
          ]),
          el("div", { class: "row section-gap" }, [
            duration,
            button("Set time", () => {
              const n = Number(duration.value);
              if (!Number.isFinite(n) || n < 1 || n > 180)
                return fail("Choose a duration from 1 to 180 minutes.");
              clearInterval(timer);
              timer = null;
              remaining = Math.round(n * 60);
              render();
            }),
          ]),
        ]),
      );
      tick();
    } else if (active === "garden") {
      panel.append(
        text(
          "div",
          state.garden ? "🌱".repeat(Math.min(state.garden, 24)) : "🌰",
          "garden center",
        ),
        text(
          "p",
          `${state.garden} focus session${state.garden === 1 ? "" : "s"} completed`,
          "center",
        ),
        el("div", { class: "row" }, [
          button(
            "Log a focus session",
            () => {
              state.garden++;
              store();
              render();
            },
            "primary",
          ),
          button("Reset garden", () => {
            state.garden = 0;
            store();
            render();
          }),
        ]),
        text(
          "p",
          "Try the garden by logging a session. Finishing the focus timer also adds a plant.",
          "muted section-gap",
        ),
      );
    } else if (active === "tasks" || active === "habits") {
      const field = input(
        active === "tasks" ? "Add a task" : "Add a daily habit",
      );
      const submit = () => {
        const title = field.value.trim();
        if (!title) return fail("Please enter a name.");
        add(active, { title, done: false, day: new Date().toDateString() });
      };
      panel.append(
        el(
          "form",
          {
            class: "row",
            onSubmit: (e) => {
              e.preventDefault();
              submit();
            },
          },
          [
            field,
            el("button", { text: "Add", class: "primary", type: "submit" }),
          ],
        ),
      );
      list(active, (item) => {
        const done =
          active === "habits" && item.day !== new Date().toDateString()
            ? false
            : item.done;
        const check = el("input", {
          type: "checkbox",
          "aria-label": item.title,
          onChange: () => {
            item.done = !done;
            item.day = new Date().toDateString();
            store();
            render();
          },
        });
        check.checked = done;
        return el("div", { class: "item" }, [
          check,
          text("span", item.title, "text"),
          deleteButton(active, item),
        ]);
      });
    } else if (active === "notes") {
      const editing = state.notes.find((item) => item.id === editingNote);
      const area = el("textarea", {
        "aria-label": "Write a note",
        placeholder: "What’s on your mind?",
        maxlength: "5000",
      });
      area.value = editing?.text || "";
      panel.append(
        area,
        button(
          editing ? "Save changes" : "Save note",
          () => {
            if (!area.value.trim()) return fail("Write a note first.");
            if (editing) {
              editing.text = area.value.trim();
              editingNote = null;
              store();
              render();
            } else add("notes", { text: area.value.trim() });
          },
          "primary section-gap",
        ),
      );
      if (editing)
        panel.append(
          button(
            "Cancel edit",
            () => {
              editingNote = null;
              render();
            },
            "section-gap",
          ),
        );
      list("notes", (item) =>
        el("div", { class: "item" }, [
          text("span", item.text, "text"),
          button("Edit", () => {
            editingNote = item.id;
            render();
            document.querySelector("textarea")?.focus();
          }),
          deleteButton("notes", item),
        ]),
      );
    } else if (active === "insights") {
      const stats = [
        ["Tasks complete", state.tasks.filter((x) => x.done).length],
        [
          "Habit check-ins",
          state.habits.filter(
            (x) => x.done && x.day === new Date().toDateString(),
          ).length,
        ],
        ["Focus sessions", state.garden],
        [
          "Minutes moved",
          state.workouts.reduce((s, x) => s + Number(x.minutes || 0), 0),
        ],
      ];
      panel.append(
        el(
          "div",
          { class: "row section-gap" },
          stats.map(([label, value]) =>
            el("div", { class: "stat" }, [
              text("b", String(value)),
              text("span", label),
            ]),
          ),
        ),
        text(
          "p",
          "Your summary updates as you use the features in this demo.",
          "muted section-gap",
        ),
      );
    } else if (active === "breathing") {
      const orb = text("div", "Ready?", "orb"),
        go = button(
          "Start breathing",
          () => {
            if (breathing) {
              clearInterval(breathing);
              breathing = null;
              orb.classList.remove("breathe");
              orb.textContent = "Ready?";
              go.textContent = "Start breathing";
              return;
            }
            orb.classList.add("breathe");
            orb.textContent = "Breathe in";
            let inward = true;
            breathing = setInterval(() => {
              inward = !inward;
              orb.textContent = inward ? "Breathe in" : "Breathe out";
            }, 4000);
            go.textContent = "Stop";
          },
          "primary",
        );
      panel.append(
        el("div", { class: "center" }, [
          orb,
          go,
          text(
            "p",
            "Four seconds in. Four seconds out. Go at your own pace.",
            "muted section-gap",
          ),
        ]),
      );
    } else if (active === "journal") {
      let mood = "";
      const moods = el("div", { class: "moods" });
      ["😔", "😕", "😐", "🙂", "😊"].forEach((m, i) =>
        moods.append(
          button(
            m,
            (e) => {
              mood = m;
              for (const b of moods.children)
                b.setAttribute("aria-pressed", "false");
              e.currentTarget.setAttribute("aria-pressed", "true");
            },
            "",
            {
              "aria-label": ["Very low", "Low", "Okay", "Good", "Great"][i],
              "aria-pressed": "false",
            },
          ),
        ),
      );
      const area = el("textarea", {
        "aria-label": "Your reflection",
        placeholder: "A few words about your day…",
        maxlength: "5000",
      });
      panel.append(
        moods,
        area,
        button(
          "Save check-in",
          () => {
            if (!mood) return fail("Choose a mood before saving.");
            add("journal", {
              mood,
              text: area.value.trim(),
              date: new Date().toLocaleDateString(),
            });
          },
          "primary section-gap",
        ),
      );
      list("journal", (item) =>
        el("div", { class: "item" }, [
          text("span", item.mood),
          text(
            "span",
            `${item.date} · ${item.text || "A moment to check in."}`,
            "text",
          ),
          deleteButton("journal", item),
        ]),
      );
    } else if (active === "workouts") {
      const name = input("Activity name"),
        minutes = input("Minutes", "number");
      minutes.min = "1";
      minutes.max = "1440";
      panel.append(
        el(
          "form",
          {
            class: "row",
            onSubmit: (e) => {
              e.preventDefault();
              const n = Number(minutes.value);
              if (
                !name.value.trim() ||
                !Number.isFinite(n) ||
                n <= 0 ||
                n > 1440
              )
                return fail(
                  "Enter an activity and a duration from 1 to 1440 minutes.",
                );
              add("workouts", { title: name.value.trim(), minutes: n });
            },
          },
          [
            name,
            minutes,
            el("button", {
              text: "Log activity",
              type: "submit",
              class: "primary",
            }),
          ],
        ),
      );
      list("workouts", (item) =>
        el("div", { class: "item" }, [
          text("span", `${item.title} · ${item.minutes} min`, "text"),
          deleteButton("workouts", item),
        ]),
      );
    } else if (active === "goals") {
      const name = input("Goal name"),
        target = input("Target", "number");
      target.min = "1";
      panel.append(
        el(
          "form",
          {
            class: "row",
            onSubmit: (e) => {
              e.preventDefault();
              const n = Number(target.value);
              if (!name.value.trim() || !Number.isFinite(n) || n < 1 || n > 1e9)
                return fail(
                  "Enter a goal and a positive target up to 1 billion.",
                );
              add("goals", {
                title: name.value.trim(),
                target: n,
                progress: 0,
              });
            },
          },
          [
            name,
            target,
            el("button", {
              text: "Add goal",
              type: "submit",
              class: "primary",
            }),
          ],
        ),
      );
      list("goals", (item) => {
        const plus = button("+1", () => {
          item.progress = Math.min(item.target, item.progress + 1);
          store();
          render();
        });
        plus.disabled = item.progress >= item.target;
        return el("div", { class: "item" }, [
          el("div", { class: "text" }, [
            text("div", `${item.title} · ${item.progress}/${item.target}`),
            el("progress", {
              class: "progress",
              value: String(item.progress),
              max: String(item.target),
              "aria-label": item.title,
            }),
          ]),
          plus,
          deleteButton("goals", item),
        ]);
      });
    } else if (active === "flashcards") {
      const q = input("Question"),
        a = input("Answer");
      panel.append(
        el(
          "form",
          {
            class: "row",
            onSubmit: (e) => {
              e.preventDefault();
              if (!q.value.trim() || !a.value.trim())
                return fail("Enter both a question and an answer.");
              add("flashcards", {
                question: q.value.trim(),
                answer: a.value.trim(),
              });
            },
          },
          [
            q,
            a,
            el("button", {
              text: "Add card",
              class: "primary",
              type: "submit",
            }),
          ],
        ),
      );
      if (state.flashcards.length) {
        cardIndex %= state.flashcards.length;
        const card = state.flashcards[cardIndex];
        panel.append(
          button(
            flipped ? card.answer : card.question,
            () => {
              flipped = !flipped;
              render();
            },
            "card-flip",
            { "aria-label": flipped ? "Show question" : "Show answer" },
          ),
          el("div", { class: "row" }, [
            text(
              "span",
              `${cardIndex + 1} of ${state.flashcards.length} · Click the card to flip`,
              "text muted",
            ),
            button("Next card", () => {
              cardIndex++;
              flipped = false;
              render();
            }),
            deleteButton("flashcards", card),
          ]),
        );
      } else panel.append(empty("Add a card to start practicing."));
    } else if (active === "budget" || active === "expenses") {
      if (active === "budget") {
        const limit = input(
          "Monthly budget",
          "number",
          String(state.budget || ""),
        );
        limit.min = "0";
        limit.step = "0.01";
        panel.append(
          el("div", { class: "row" }, [
            limit,
            button(
              "Set budget",
              () => {
                const n = Number(limit.value);
                if (
                  !limit.value.trim() ||
                  !Number.isFinite(n) ||
                  n < 0 ||
                  n > 1e12
                )
                  return fail("Enter a budget from 0 to 1 trillion.");
                state.budget = n;
                store();
                render();
              },
              "primary",
            ),
          ]),
          el("div", { class: "row section-gap" }, [
            el("div", { class: "stat" }, [
              text("b", money(state.budget - sum())),
              text("span", "Remaining"),
            ]),
            el("div", { class: "stat" }, [
              text("b", money(sum())),
              text("span", "Spent"),
            ]),
          ]),
        );
      }
      const description = input("Expense description"),
        amount = input("Amount", "number");
      amount.min = "0.01";
      amount.step = "0.01";
      panel.append(
        el(
          "form",
          {
            class: "row section-gap",
            onSubmit: (e) => {
              e.preventDefault();
              const n = Number(amount.value);
              if (
                !description.value.trim() ||
                !Number.isFinite(n) ||
                n <= 0 ||
                n > 1e12
              )
                return fail(
                  "Enter a description and a positive amount up to 1 trillion.",
                );
              add("expenses", {
                title: description.value.trim(),
                amount: Math.round(n * 100) / 100,
              });
            },
          },
          [
            description,
            amount,
            el("button", {
              text: "Add expense",
              class: "primary",
              type: "submit",
            }),
          ],
        ),
      );
      list("expenses", (item) =>
        el("div", { class: "item" }, [
          text("span", `${item.title} · ${money(item.amount)}`, "text"),
          deleteButton("expenses", item),
        ]),
      );
    } else if (active === "reading" || active === "bookmarks") {
      const title = input(
          active === "reading" ? "Book or article title" : "Link title",
        ),
        url = input(active === "reading" ? "Web link (optional)" : "Web link");
      panel.append(
        el(
          "form",
          {
            class: "row",
            onSubmit: (e) => {
              e.preventDefault();
              if (!title.value.trim()) return fail("Enter a title.");
              if (
                (url.value.trim() || active === "bookmarks") &&
                !safeUrl(url.value.trim())
              )
                return fail("Enter a full http:// or https:// link.");
              add(active, {
                title: title.value.trim(),
                url: url.value.trim() ? safeUrl(url.value.trim()) : "",
                done: false,
              });
            },
          },
          [
            title,
            url,
            el("button", { text: "Save", type: "submit", class: "primary" }),
          ],
        ),
      );
      list(active, (item) => {
        const parts = [
          item.url
            ? el("a", {
                href: item.url,
                target: "_blank",
                rel: "noopener noreferrer",
                text: item.title,
                class: "text",
              })
            : text("span", item.title, "text"),
        ];
        if (active === "reading")
          parts.push(
            button(item.done ? "Read ✓" : "Mark read", () => {
              item.done = !item.done;
              store();
              render();
            }),
          );
        parts.push(deleteButton(active, item));
        return el("div", { class: "item" }, parts);
      });
    } else if (active === "boards") {
      const idea = input("A new idea");
      panel.append(
        el(
          "form",
          {
            class: "row",
            onSubmit: (e) => {
              e.preventDefault();
              if (!idea.value.trim()) return fail("Write an idea first.");
              add("boards", { title: idea.value.trim(), status: "To explore" });
            },
          },
          [
            idea,
            el("button", {
              text: "Add idea",
              class: "primary",
              type: "submit",
            }),
          ],
        ),
      );
      list("boards", (item) => {
        const select = el(
          "select",
          {
            "aria-label": `Status for ${item.title}`,
            onChange: (e) => {
              item.status = e.target.value;
              store();
              render();
            },
          },
          ["To explore", "In progress", "Done"].map((v) =>
            el("option", { value: v, text: v }),
          ),
        );
        select.value = item.status;
        return el("div", { class: "item" }, [
          text("span", item.title, "text"),
          select,
          deleteButton("boards", item),
        ]);
      });
    }
    panel.append(error);
    shell.append(
      text(
        "p",
        "A template-based browser demo. Your entries stay in this browser.",
        "footer",
      ),
    );
  }
  function tick() {
    if (timer) {
      remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (remaining === 0) {
        clearInterval(timer);
        timer = null;
        state.garden++;
        store();
        render();
      }
    }
    const digits = document.querySelector(".digits");
    if (digits)
      digits.textContent =
        String(Math.floor(remaining / 60)).padStart(2, "0") +
        ":" +
        String(remaining % 60).padStart(2, "0");
  }
  window.addEventListener("pagehide", () => {
    clearInterval(timer);
    clearInterval(breathing);
  });
  render();
})();
