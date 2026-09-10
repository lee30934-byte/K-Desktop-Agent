"""Exercise the production UPSERT SQL on an isolated in-memory SQLite database."""
import re
import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = (root / "src" / "messagePersistence.ts").read_text(encoding="utf-8")
sql = re.search(r"MESSAGE_UPSERT_SQL = `([\s\S]*?)`;", source).group(1)
db = sqlite3.connect(":memory:")
db.execute("CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT, content TEXT, timestamp INTEGER, streaming INTEGER, level TEXT, tool_id TEXT, tool_name TEXT, tool_input TEXT, tool_output TEXT, tool_status TEXT, tool_risk TEXT)")
def write(conversation, content):
    return db.execute(sql, ("message-1", conversation, "assistant", content, 1, 0, None, None, None, None, None, None, None)).rowcount
assert write("a", "partial") == 1
assert write("a", "complete") == 1
assert write("b", "contaminated") == 0
assert db.execute("SELECT conversation_id, content FROM messages").fetchall() == [("a", "complete")]
print("SQLite message ownership: PASS (same-chat update allowed, cross-chat overwrite rejected)")
