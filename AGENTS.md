# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

A simple substitute for Notion, aimed at low-powered machines and smaller teams. Stack: Node.js, TypeScript, React (per [README.md](README.md)).

## Current state

The repository is a bare scaffold: no source code, package manifest, build tooling, linter, or tests have been committed yet. [README.md](README.md) is a placeholder ("TODO: Provide proper readme").

Because of this, there are no build, lint, or test commands and no architecture to document yet. Update this file once the project is set up (package manager, scripts, directory layout, how the frontend and Node backend relate).

## Design constraint worth preserving

The project's stated purpose is to run well on low-powered machines, so prefer lightweight dependencies and avoid heavy runtime or bundle costs when making choices.
