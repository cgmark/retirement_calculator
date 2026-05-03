.PHONY: help test build run licenses

.DEFAULT_GOAL := help

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*##"; print "Available targets:"} /^[a-zA-Z_-]+:.*##/ {printf "  %-10s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

test: ## Run unit tests
	npm test

build: ## Build single-file HTML
	npm run build:single

run: ## Start local dev server
	npm run dev

licenses: ## Generate third-party license report
	npm run licenses
