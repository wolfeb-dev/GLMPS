CREATE TABLE sessions (
  id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, cwd TEXT,
  started_at REAL, ended_at REAL, parent_session_id TEXT, archived INTEGER);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
  tool_calls TEXT, tool_name TEXT, timestamp REAL, reasoning TEXT, active INTEGER DEFAULT 1);
INSERT INTO sessions VALUES ('golden','cli','anthropic/claude-opus-4.6','Golden hermes session','D:\proj',1751400000,NULL,NULL,0);
INSERT INTO messages (session_id, role, content, timestamp) VALUES ('golden','user','Run the test suite and report failures',1751400001);
INSERT INTO messages (session_id, role, tool_calls, timestamp, reasoning) VALUES ('golden','assistant','[{"function":{"name":"terminal","arguments":"{\"command\":\"npm test\"}"}}]',1751400002,'Plan: run tests, read output');
