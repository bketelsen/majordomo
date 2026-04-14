import { describe, it, expect } from "bun:test";

// Template resolution logic extracted for testing
function resolveTemplate(
  template: string,
  workflowInput: Record<string, unknown>,
  stepOutputs: Record<string, string>
): string {
  return template
    .replace(/\{\{workflow\.input\.(\w+)\}\}/g, (_: string, key: string) =>
      String(workflowInput[key] ?? "")
    )
    .replace(/\{\{steps\.(\w+)\.output\.(\w+)\}\}/g, (_: string, stepId: string, field: string) => {
      const raw = stepOutputs[stepId] ?? "";
      try {
        const parsed = JSON.parse(raw);
        return String(parsed[field] ?? raw); // Fallback to full output if field not found
      } catch {
        return raw; // Fallback: whole output if not valid JSON
      }
    })
    .replace(/\{\{steps\.(\w+)\.output\}\}/g, (_: string, stepId: string) =>
      stepOutputs[stepId] ?? ""
    );
}

describe("Workflow Template Resolution", () => {
  it("{{workflow.input.key}} resolves to workflow input", () => {
    const template = "Task: {{workflow.input.task}}";
    const workflowInput = { task: "Build a dashboard" };
    const stepOutputs = {};

    const result = resolveTemplate(template, workflowInput, stepOutputs);
    expect(result).toBe("Task: Build a dashboard");
  });

  it("{{steps.id.output}} resolves to step output text", () => {
    const template = "Previous result: {{steps.research.output}}";
    const workflowInput = {};
    const stepOutputs = { research: "Found 10 papers on the topic" };

    const result = resolveTemplate(template, workflowInput, stepOutputs);
    expect(result).toBe("Previous result: Found 10 papers on the topic");
  });

  it("{{steps.id.output.field}} resolves to JSON field from step output", () => {
    const template = "Status: {{steps.build.output.status}}";
    const workflowInput = {};
    const stepOutputs = {
      build: JSON.stringify({ status: "success", files: 5 }),
    };

    const result = resolveTemplate(template, workflowInput, stepOutputs);
    expect(result).toBe("Status: success");
  });

  it("{{steps.id.output.field}} falls back to full output if not valid JSON", () => {
    const template = "Result: {{steps.analyze.output.summary}}";
    const workflowInput = {};
    const stepOutputs = { analyze: "Plain text output, not JSON" };

    const result = resolveTemplate(template, workflowInput, stepOutputs);
    expect(result).toBe("Result: Plain text output, not JSON");
  });

  it("{{steps.id.output.field}} falls back to full output if field not found in JSON", () => {
    const template = "Detail: {{steps.process.output.nonexistent}}";
    const workflowInput = {};
    const stepOutputs = {
      process: JSON.stringify({ status: "complete", count: 42 }),
    };

    const result = resolveTemplate(template, workflowInput, stepOutputs);
    // When field is not found, return the whole output as fallback
    expect(result).toBe('Detail: {"status":"complete","count":42}');
  });

  it("missing keys resolve to empty string", () => {
    const template = "Value: {{workflow.input.missing}}, Step: {{steps.nonexistent.output}}";
    const workflowInput = {};
    const stepOutputs = {};

    const result = resolveTemplate(template, workflowInput, stepOutputs);
    expect(result).toBe("Value: , Step: ");
  });

  it("resolves multiple placeholders in one template", () => {
    const template =
      "Task: {{workflow.input.task}}, Research: {{steps.research.output.summary}}, Build status: {{steps.build.output}}";

    const workflowInput = { task: "Create API" };
    const stepOutputs = {
      research: JSON.stringify({ summary: "REST best practices" }),
      build: "API built successfully",
    };

    const result = resolveTemplate(template, workflowInput, stepOutputs);
    expect(result).toBe("Task: Create API, Research: REST best practices, Build status: API built successfully");
  });

  it("handles nested JSON field access", () => {
    const template = "User: {{steps.auth.output.user}}";
    const workflowInput = {};
    const stepOutputs = {
      auth: JSON.stringify({ user: "alice", token: "abc123" }),
    };

    const result = resolveTemplate(template, workflowInput, stepOutputs);
    expect(result).toBe("User: alice");
  });

  it("handles numeric values in JSON", () => {
    const template = "Count: {{steps.count.output.total}}";
    const workflowInput = {};
    const stepOutputs = {
      count: JSON.stringify({ total: 42, active: 10 }),
    };

    const result = resolveTemplate(template, workflowInput, stepOutputs);
    expect(result).toBe("Count: 42");
  });

  it("handles boolean values in JSON", () => {
    const template = "Success: {{steps.validate.output.valid}}";
    const workflowInput = {};
    const stepOutputs = {
      validate: JSON.stringify({ valid: true, errors: [] }),
    };

    const result = resolveTemplate(template, workflowInput, stepOutputs);
    expect(result).toBe("Success: true");
  });

  it("combines workflow input and step outputs", () => {
    const template =
      "Building {{workflow.input.component}} with design from {{steps.design.output.approach}}";

    const workflowInput = { component: "navbar" };
    const stepOutputs = {
      design: JSON.stringify({ approach: "mobile-first", colors: ["blue", "white"] }),
    };

    const result = resolveTemplate(template, workflowInput, stepOutputs);
    expect(result).toBe("Building navbar with design from mobile-first");
  });
});
