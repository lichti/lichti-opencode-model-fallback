SHELL := /bin/bash

PLUGIN_ENTRY := $(CURDIR)/index.js
HOME_DIR     := $(HOME)/.opencode
CONFIG_PATH  := $(HOME)/.config/opencode/opencode.json
DATA_FILE    := $(HOME_DIR)/model-fallback.json
PLUGIN_LOG   := $(HOME_DIR)/model-fallback-plugin.log

.DEFAULT_GOAL := help

.PHONY: help install uninstall doctor status

help: ## Lista os alvos disponiveis
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Registra o plugin em opencode.json e cria model-fallback.json se faltar
	@command -v python3 >/dev/null 2>&1 || { echo "python3 nao encontrado (necessario para editar opencode.json com seguranca)."; exit 1; }
	@mkdir -p "$(HOME_DIR)"
	@if [ -f "$(DATA_FILE)" ]; then \
		read -r -p "$(DATA_FILE) ja existe. Sobrescrever com o exemplo? [y/N] " reply; \
		case "$$reply" in \
			[yY]*) cp model-fallback.example.json "$(DATA_FILE)"; echo "Sobrescrito: $(DATA_FILE)";; \
			*) echo "Mantido (nao sobrescrito): $(DATA_FILE)";; \
		esac; \
	else \
		cp model-fallback.example.json "$(DATA_FILE)"; \
		echo "Criado: $(DATA_FILE) (edite fallbackModels para os modelos do seu provider)"; \
	fi
	@python3 scripts/register-plugin.py add "$(PLUGIN_ENTRY)"
	@echo "Instalacao concluida. Rode 'make doctor' para verificar."

uninstall: ## Remove o plugin de opencode.json (nao mexe em model-fallback.json)
	@command -v python3 >/dev/null 2>&1 || { echo "python3 nao encontrado."; exit 1; }
	@python3 scripts/register-plugin.py remove "$(PLUGIN_ENTRY)"

doctor: ## Verifica se o plugin esta registrado e configurado corretamente
	@echo "== opencode =="
	@command -v opencode >/dev/null 2>&1 && echo "  ok: instalado" || echo "  falta: npm install -g opencode-ai"
	@echo "== plugin registrado em opencode.json =="
	@python3 -c "import json,sys; from pathlib import Path; p=Path('$(CONFIG_PATH)'); d=json.loads(p.read_text()) if p.exists() else {}; sys.exit(0 if '$(PLUGIN_ENTRY)' in d.get('plugin', []) else 1)" \
		&& echo "  ok: $(PLUGIN_ENTRY)" \
		|| echo "  falta: make install"
	@echo "== config =="
	@[ -f "$(DATA_FILE)" ] && echo "  ok: $(DATA_FILE)" || echo "  falta: make install"
	@echo "== log =="
	@[ -f "$(PLUGIN_LOG)" ] && echo "  ok: $(PLUGIN_LOG) (veja 'make status')" || echo "  info: ainda sem log (normal antes do primeiro 'opencode')"

status: ## Mostra as ultimas linhas do log do plugin
	@[ -f "$(PLUGIN_LOG)" ] && tail -n 30 "$(PLUGIN_LOG)" || echo "Nenhum log ainda em $(PLUGIN_LOG) - rode 'opencode' primeiro."
