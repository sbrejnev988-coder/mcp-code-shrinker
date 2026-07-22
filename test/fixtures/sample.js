export function hello(name) {
  return `Hello, ${name}!`;
}

export class Greeter {
  constructor(greeting) {
    this.greeting = greeting;
  }

  greet(name) {
    return `${this.greeting}, ${name}!`;
  }

  static create() {
    return new Greeter("Hi");
  }
}

export const VERSION = "1.0.0";

// Arrow function
export const double = (x) => x * 2;
