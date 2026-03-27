import { describe, it, expect } from "vitest";
import { classifyQuery } from "./classifier.ts";

describe("classifyQuery - Smart Routing Classifier", () => {
  describe("simple queries", () => {
    it("should classify basic greetings as simple", () => {
      const result = classifyQuery("Hello!");
      expect(result.tier).toBe("simple");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("should classify polite responses as simple", () => {
      const result = classifyQuery("Thanks for your help!");
      expect(result.tier).toBe("simple");
    });

    it("should classify what time questions as simple", () => {
      const result = classifyQuery("What time is it?");
      expect(result.tier).toBe("simple");
    });

    it("should classify identity questions as simple", () => {
      const result = classifyQuery("What is your name?");
      expect(result.tier).toBe("simple");
    });

    it("should classify goodbye as simple", () => {
      const result = classifyQuery("Bye!");
      expect(result.tier).toBe("simple");
    });
  });

  describe("moderate queries", () => {
    it("should classify queries with single code block as moderate", () => {
      const result = classifyQuery("Here's my function:\n```\nfunction test() { return 42; }\n```");
      expect(result.tier).toBe("moderate");
    });

    it("should classify creative requests with code block as moderate", () => {
      const result = classifyQuery("Write and compose a poem:\n```\nhello world\n```");
      expect(result.tier).toBe("moderate");
    });

    it("should classify multi-step instructions with multiple code blocks as moderate or complex", () => {
      const result = classifyQuery(
        `First: \`\`\`npm install\`\`\`, then: \`\`\`npm start\`\`\`, finally: \`\`\`npm test\`\`\``,
      );
      expect(["moderate", "complex"]).toContain(result.tier);
    });

    it("should classify very long queries as moderate or complex", () => {
      const longQuery = "analyze and debug and optimize and refactor. ".repeat(30);
      const result = classifyQuery(longQuery);
      expect(["moderate", "complex"]).toContain(result.tier);
    });
  });

  describe("complex queries", () => {
    it("should classify complex queries with code blocks and heavy keywords as complex", () => {
      // Requires very high keyword density + multiple code blocks + length
      const result = classifyQuery(
        `Design distributed system:\n\`\`\`\nclass Cache { replicate() {} }\nclass Node { consensus() {} }\nclass Storage { encrypt() {} }\n\`\`\`\nAnalyze and evaluate architecture: scalability patterns, concurrency control, distributed replication strategies, consensus algorithms, encryption protocols, fault tolerance mechanisms, and deployment considerations`,
      );
      expect(result.tier).toBe("complex");
    });

    it("should classify code optimization with multiple implementations as complex", () => {
      const result = classifyQuery(
        `Refactor and optimize:\n\`\`\`\nfunction fibonacci(n) { return n <= 1 ? n : fib(n-1) + fib(n-2); }\nfunction fib(n) { const cache = {}; return cache[n] || (cache[n] = optimized(n)); }\nfunction optimized(n) { return tabulation(n); }\n\`\`\`\nAnalyze time complexity, implement memoization, evaluate space-time tradeoffs`,
      );
      expect(result.tier).toBe("complex");
    });

    it("should classify system architecture comparison as complex", () => {
      const result = classifyQuery(
        `Compare architectures:\n\`\`\`\nclass Microservice { async call() {} }\nclass Monolith { sync call() {} }\n\`\`\`\nAnalyze and evaluate trade-offs: scalability patterns, consistency models, distributed deployment strategies, consensus protocols, and architectural implications`,
      );
      expect(result.tier).toBe("complex");
    });

    it("should classify security system implementation as complex", () => {
      const result = classifyQuery(
        `Implement security:\n\`\`\`\nfunction encrypt(data) {}\nfunction authenticate(user) {}\nfunction authorize(user, resource) {}\n\`\`\`\nAnalyze and evaluate: encryption algorithms, authentication protocols, authorization constraints, vulnerability assessment, compliance requirements, and security patterns`,
      );
      expect(result.tier).toBe("complex");
    });

    it("should classify detailed API design with optimization as complex", () => {
      const query = `Design API:\n\`\`\`typescript\nasync function fetchData(url: string) { const response = await fetch(url); return response.json(); }\nclass Handler { process(data) { return this.cache[key] || compute(data); } }\nfunction optimize() { implement caching; }\n\`\`\`\nEvaluate and implement: caching strategies, scalability patterns, distributed architecture, performance optimization`;
      const result = classifyQuery(query);
      expect(result.tier).toBe("complex");
    });

    it("should classify advanced algorithm design as complex", () => {
      const result = classifyQuery(
        `Design algorithm:\n\`\`\`\nfunction buildBalancedTree(n) { return construct(n); }\nfunction balance() { rebalance(); }\nfunction optimize() { tune performance; }\n\`\`\`\nAnalyze and evaluate: time complexity, space complexity, optimization strategies, performance implications`,
      );
      expect(result.tier).toBe("complex");
    });

    it("should classify comprehensive security analysis as complex", () => {
      const result = classifyQuery(
        `Security:\n\`\`\`\nfunction encrypt() {}\nfunction authenticate() {}\nfunction authorize() {}\nfunction validate() {}\n\`\`\`\nEvaluate encryption methods, authentication protocols, authorization constraints, compliance, vulnerability assessment, distributed security patterns, and risk mitigation`,
      );
      expect(result.tier).toBe("complex");
    });
  });

  describe("scoring and confidence", () => {
    it("should provide confidence scores between 0 and 1", () => {
      const queries = [
        "hello",
        "how do I write a function",
        "analyze a distributed system with consensus protocol and fault tolerance",
      ];

      for (const query of queries) {
        const result = classifyQuery(query);
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      }
    });

    it("should have different confidence for simple vs complex queries", () => {
      const simpleResult = classifyQuery("Hi");
      const complexResult = classifyQuery(
        `Implement and analyze:\n\`\`\`\nfunction process() {}\n\`\`\`\nEvaluate performance and optimize`,
      );
      // Complex queries should trigger higher confidence scores
      expect(complexResult.confidence).toBeGreaterThan(simpleResult.confidence);
    });

    it("should include dimension scores", () => {
      const result = classifyQuery("Write a function to sort an array");
      expect(result.scores).toBeDefined();
      expect(Object.keys(result.scores).length).toBeGreaterThan(0);
      expect(result.scores.code).toBeGreaterThan(0);
    });
  });

  describe("edge cases", () => {
    it("should handle empty strings", () => {
      const result = classifyQuery("");
      expect(result.tier).toBe("simple");
      expect(result.confidence).toBeDefined();
    });

    it("should handle very long queries", () => {
      const longQuery = "analyze ".repeat(1000) + "distributed systems";
      const result = classifyQuery(longQuery);
      expect(result.tier).toBeDefined();
      expect(["simple", "moderate", "complex"]).toContain(result.tier);
    });

    it("should handle mixed case keywords", () => {
      const result = classifyQuery("ANALYZE and COMPARE the ALGORITHM implementation");
      expect(result.tier).toBeDefined();
    });

    it("should handle code blocks with special characters as moderate or complex", () => {
      const result = classifyQuery(
        `Debug:\n\`\`\`\nconst x = 5; function test() { return x * 2; }\n\`\`\`\nAnd:\n\`\`\`\nfunction process() { }\n\`\`\``,
      );
      expect(["moderate", "complex"]).toContain(result.tier);
    });

    it("should handle multiple code blocks and score them", () => {
      const query = `Here are functions:\n\`\`\`js\nfunction add(a, b) { return a + b; }\n\`\`\`\nAnd:\n\`\`\`js\nfunction multiply(a, b) { return a * b; }\n\`\`\``;
      const result = classifyQuery(query);
      expect(["moderate", "complex"]).toContain(result.tier);
      expect(result.scores.code_blocks).toBeGreaterThan(0);
    });

    it("should handle unicode characters", () => {
      const result = classifyQuery("Hello 👋 analyze the function 🔍");
      expect(result.tier).toBeDefined();
    });
  });

  describe("dimension weighting", () => {
    it("should weight code dimension heavily", () => {
      const codeHeavyQuery = "implement a function with async await and class definition";
      const result = classifyQuery(codeHeavyQuery);
      expect(result.scores.code).toBeGreaterThan(0);
    });

    it("should weight reasoning dimension heavily for analyze/compare queries", () => {
      const reasoningQuery =
        "analyze and compare and evaluate the pros and cons and reasoning about this algorithm";
      const result = classifyQuery(reasoningQuery);
      expect(result.scores.reasoning).toBeGreaterThan(0.1);
    });

    it("should reduce score for simple dimension keywords", () => {
      const simpleQuery = classifyQuery("hello world thank you");
      expect(simpleQuery.tier).toBe("simple");
    });
  });

  describe("real-world scenarios", () => {
    it("scenario 1: customer support query", () => {
      const result = classifyQuery("I can't log in, it says invalid credentials. Help!");
      expect(result.tier).toBe("simple");
    });

    it("scenario 2: simple feature request", () => {
      const result = classifyQuery("Can you add a dark mode toggle?");
      expect(["simple", "moderate"]).toContain(result.tier);
    });

    it("scenario 3: code review with multiple complex blocks", () => {
      const result = classifyQuery(`
Review and optimize:\n\`\`\`typescript\nfunction processData(items: Item[]): Result {\n  return items.filter(item => item.valid).map(transform);\n}\nfunction transform(item) { return cache[item.id] || compute(item); }\nclass Handler { async process() {} }\n\`\`\`\nAnalyze and evaluate performance, scalability, and optimization strategies`);
      expect(result.tier).toBe("complex");
    });

    it("scenario 4: architecture discussion with technical keywords", () => {
      const result = classifyQuery(
        `Compare:\n\`\`\`\nSQL DB\n\`\`\`\nvs\n\`\`\`\nNoSQL DB\n\`\`\`\nAnalyze and evaluate: scalability patterns, consistency models, distributed replication, consensus, distributed deployment, and architectural patterns`,
      );
      expect(result.tier).toBe("complex");
    });

    it("scenario 5: creative writing with code", () => {
      const result = classifyQuery(
        "Write and compose a creative poem:\n```\nautumn leaves falling\n```",
      );
      expect(result.tier).toBe("moderate");
    });

    it("scenario 6: bug investigation with complex fixes", () => {
      const result = classifyQuery(
        `Debug and fix:\n\`\`\`js\nfunction processData(items) { return items.reduce((acc, item) => acc + item.value, 0); }\nfunction optimize() { cache[key] = computed; }\nfunction validate() { verify(); }\n\`\`\`\nOptimize and refactor: analyze performance, evaluate caching strategies, implement scalability patterns`,
      );
      expect(result.tier).toBe("complex");
    });
  });

  describe("tier boundaries", () => {
    it("should classify 'what is 2+2' as simple", () => {
      const result = classifyQuery("what is 2+2");
      expect(result.tier).toBe("simple");
    });

    it("should classify single code block as moderate", () => {
      const result = classifyQuery("Here's my code:\n```\nfunction test() { return 42; }\n```");
      expect(result.tier).toBe("moderate");
    });

    it("should classify algorithm queries with simple keywords as simple or moderate", () => {
      const result1 = classifyQuery("implement a sorting algorithm");
      const result2 = classifyQuery("implement a search algorithm");
      expect(["simple", "moderate"]).toContain(result1.tier);
      expect(["simple", "moderate"]).toContain(result2.tier);
    });

    it("should require multiple signals to reach complex tier", () => {
      // Single factor doesn't make it complex
      const justCode = classifyQuery("```\nfunction test() {}\n```");
      expect(justCode.tier).toBe("moderate");

      // Multiple factors do: many keywords + multiple code blocks + length
      const multipleSignals = classifyQuery(
        `Analyze and debug distributed system:\n\`\`\`\nfunction test() { return compute(); }\nfunction process() { return cache[key] || compute(); }\nclass Service { async handle() {} }\n\`\`\`\nOptimize and refactor: evaluate scalability, concurrency control, replication strategies, consensus protocols, distributed architecture, and performance optimization`,
      );
      expect(multipleSignals.tier).toBe("complex");
    });
  });
});
