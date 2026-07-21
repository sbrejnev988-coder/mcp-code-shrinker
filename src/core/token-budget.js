// ═══ Token Budget v2.0 ═══
// Proper allocation model instead of text.length / 3.5

export class TokenBudget {
  constructor({ totalBudget = 32000, model = "deepseek-v4-pro" } = {}) {
    this.totalBudget = totalBudget;
    this.model = model;
    this._charsPerToken = this._estimateCharsPerToken(model);
  }
  
  /** Allocate budget for a context packet */
  allocate({ mode = "safe", taskType = "bugfix" } = {}) {
    const budget = {
      total: this.totalBudget,
      systemPrompt: 0,
      instructions: Math.floor(this.totalBudget * 0.05),
      task: Math.floor(this.totalBudget * 0.03),
      projectMap: Math.floor(this.totalBudget * 0.05),
      contracts: 0,
      sources: 0,
      evidence: Math.floor(this.totalBudget * 0.10),
      expansionReserve: Math.floor(this.totalBudget * 0.15),
      outputReserve: Math.floor(this.totalBudget * 0.15),
      toolCalls: Math.floor(this.totalBudget * 0.05),
    };
    
    const remaining = this.totalBudget - budget.instructions - budget.task - 
      budget.projectMap - budget.evidence - budget.expansionReserve - 
      budget.outputReserve - budget.toolCalls;
    
    switch (mode) {
      case "safe":
        budget.contracts = Math.floor(remaining * 0.5);
        budget.sources = Math.floor(remaining * 0.5);
        break;
      case "balanced":
        budget.contracts = Math.floor(remaining * 0.6);
        budget.sources = Math.floor(remaining * 0.4);
        break;
      case "aggressive":
        budget.contracts = Math.floor(remaining * 0.75);
        budget.sources = Math.floor(remaining * 0.25);
        break;
    }
    
    return budget;
  }
  
  tokens(text) {
    if (!text) return 0;
    return Math.ceil(typeof text === "string" ? text.length / this._charsPerToken : 
      JSON.stringify(text).length / this._charsPerToken);
  }
  
  _estimateCharsPerToken(model) {
    // BPE approximation varies by model
    const estimates = {
      "deepseek-v4-pro": 1.25,
      "deepseek-v4-flash": 1.35,
      "gpt-5.5": 1.30,
      "gpt-5.6": 1.30,
      "mimo-v2.5-pro": 1.35,
      "mythos-nano": 1.20,
    };
    return estimates[model] || 1.35;
  }
}
