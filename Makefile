.PHONY: start dev install-hooks test clean

# Start the monitor server
start:
	@cd "$(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))" && node src/server.js

# Start with demo data
dev:
	@cd "$(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))" && node src/server.js --demo

# Install CLI hooks into Claude Code
install-hooks:
	@node "$(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))/src/install-hooks.js"

# Send a test event
test:
	@echo '{"session_id":"demo-1","hook_event_name":"SessionStart","cwd":"/test/project","_source":"claude"}' | \
		node "$(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))/src/bridge.js"
	@echo "Test event sent!"

# Clean up
clean:
	@rm -rf ~/.vibe-monitor
	@echo "Cleaned up ~/.vibe-monitor"
