import json
import sqlite3
import sys


def main() -> int:
    if len(sys.argv) < 3:
        raise SystemExit("Usage: query_codex_logs.py <db_path> <mode> [args...]")

    db_path = sys.argv[1]
    mode = sys.argv[2]

    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row

    try:
        cursor = connection.cursor()

        if mode == "max":
            cursor.execute("select coalesce(max(id), 0) as max_id from logs")
            row = cursor.fetchone()
            print(json.dumps({"maxId": int(row["max_id"]) if row else 0}, ensure_ascii=False))
            return 0

        if mode == "rows":
            if len(sys.argv) < 5:
                raise SystemExit("rows mode requires <after_id> <limit>")

            after_id = int(sys.argv[3])
            limit = int(sys.argv[4])
            cursor.execute(
                """
                select
                    id,
                    ts,
                    target,
                    message
                from logs
                where id > ?
                  and target = 'codex_app_server::codex_message_processor'
                order by id asc
                limit ?
                """,
                (after_id, limit),
            )
            rows = [
                {
                    "id": int(row["id"]),
                    "ts": int(row["ts"]),
                    "target": row["target"],
                    "message": row["message"] or "",
                }
                for row in cursor.fetchall()
            ]
            print(json.dumps(rows, ensure_ascii=False))
            return 0

        raise SystemExit(f"Unknown mode: {mode}")
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
