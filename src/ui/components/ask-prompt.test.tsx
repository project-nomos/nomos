import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { AskPrompt, type AskQuestion } from "./ask-prompt.tsx";

// Give Ink time to process the synchronous keystroke + re-render. Generous so the
// test doesn't flake when the full suite runs the machine hot.
const tick = () => new Promise((r) => setTimeout(r, 60));

const twoQuestions: AskQuestion[] = [
  {
    question: "Ship now or wait?",
    header: "Timing",
    options: [{ label: "Ship it" }, { label: "Wait" }],
  },
  { question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
];

describe("AskPrompt (CLI/Ink Ask card)", () => {
  it("renders the first question with header, options, and progress", () => {
    const { lastFrame } = render(<AskPrompt questions={twoQuestions} onSubmit={() => {}} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("Ship now or wait?");
    expect(f).toContain("Timing");
    expect(f).toContain("Ship it");
    expect(f).toContain("Wait");
    expect(f).toContain("1/2"); // shows it's the first of two questions
  });

  it("collects one answer per question and submits the set", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<AskPrompt questions={twoQuestions} onSubmit={onSubmit} />);

    stdin.write("2"); // Q1 → highlight "Wait"
    stdin.write("\r"); // confirm Q1 → advance
    await tick();
    expect(lastFrame() ?? "").toContain("Which DB?"); // Q2 now shown

    stdin.write("1"); // Q2 → highlight "Postgres"
    stdin.write("\r"); // confirm Q2 → submit (last)
    await tick();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      "Ship now or wait?": "Wait",
      "Which DB?": "Postgres",
    });
  });

  it("joins multiSelect picks with ', '", async () => {
    const onSubmit = vi.fn();
    const multi: AskQuestion[] = [
      {
        question: "Dietary constraints?",
        multiSelect: true,
        options: [{ label: "Vegan" }, { label: "Gluten-free" }, { label: "None" }],
      },
    ];
    const { stdin } = render(<AskPrompt questions={multi} onSubmit={onSubmit} />);
    stdin.write("1"); // toggle Vegan
    stdin.write("2"); // toggle Gluten-free
    stdin.write("\r"); // submit
    await tick();
    expect(onSubmit).toHaveBeenCalledWith({ "Dietary constraints?": "Vegan, Gluten-free" });
  });
});
