# Tauri + React Modern Template

A feature-rich Tauri + React development template, integrated with the latest development tools and frameworks.

## Features

- [Tauri](https://tauri.app/) - Build smaller, faster, and more secure desktop applications
- [Rsbuild](https://rsbuild.dev/) - High-performance build tool
- [React 19](https://react.dev/) - Latest version of React
- [Tailwind CSS v4](https://tailwindcss.com/) - Next generation utility-first CSS framework
- [Bun](https://bun.sh/) - High-performance JavaScript runtime and package manager
- [React Scan](https://github.com/react-scan/react-scan) - React application performance analysis tool
- [shadcn/ui](https://ui.shadcn.com/docs) - Beautifully designed components built with Radix UI and Tailwind CSS
- [tauri-specta](https://github.com/specta-rs/tauri-specta) - Generate TypeScript bindings for Tauri commands and events
- [surrealdb](https://surrealdb.com/) - A NoSQL database designed for the next generation of applications
- [xstate](https://xstate.js.org/) - A state management library for React, using state machines
- [arktype](https://arktype.dev/) - A type system for JavaScript and TypeScript
- [Effect](https://www.effect.institute/) - A functional programming library for TypeScript
- [React Doctor](https://github.com/millionco/react-doctor) - One command scans your codebase for security, performance, correctness, and architecture issues, then outputs a 0–100 score with actionable diagnostics.

## Getting Started

### Installation

```bash
bun install
bunx tauri signer generate -w .tauri/myapp.key
```

### Development

Start the development server:

```bash
bun tauri dev
```

Add a shadcn component:

```bash
bunx --bun shadcn@latest add [components]
```
