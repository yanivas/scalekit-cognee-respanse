#!/usr/bin/env python3
import asyncio
import json
import os
import sys


async def get_user(email):
    if not email:
        return None
    try:
        from cognee.modules.users.methods import create_user, get_user_by_email
    except Exception:
        return None

    user = await get_user_by_email(email)
    if user:
        return user
    return await create_user(email, os.environ.get("COGNEE_DEMO_PASSWORD", "hackathon-pw"))


async def ensure_database():
    from cognee.infrastructure.databases.relational.create_db_and_tables import create_db_and_tables

    await create_db_and_tables()


def result_to_text(item):
    for attr in ("text", "content", "body"):
        value = getattr(item, attr, None)
        if value:
            return str(value)
    if isinstance(item, dict):
        for key in ("text", "content", "body"):
            if item.get(key):
                return str(item[key])
    return str(item)


def result_to_source(item):
    if isinstance(item, dict):
        return item.get("source") or item.get("node_set") or item.get("metadata")
    for attr in ("source", "node_set", "metadata"):
        value = getattr(item, attr, None)
        if value:
            return value
    return None


async def remember(payload):
    import cognee

    await ensure_database()
    remembered = 0
    for doc in payload.get("documents", []):
        user = await get_user(doc.get("userEmail"))
        kwargs = {
            "dataset_name": doc["datasetName"],
            "node_set": doc.get("nodeSet") or [f"source:{doc.get('source', 'unknown')}"],
        }
        if user:
            kwargs["user"] = user

        text = "\n".join(
            [
                f"Title: {doc.get('title', 'Untitled')}",
                f"Source: {doc.get('source', 'unknown')}",
                f"Tags: {', '.join(doc.get('nodeSet') or [])}",
                "",
                doc.get("body", ""),
            ]
        )
        await cognee.remember(text, **kwargs)
        remembered += 1

    return {"provider": "cognee", "remembered": remembered}


async def recall(payload):
    import cognee

    await ensure_database()
    user = await get_user(payload.get("userEmail"))
    kwargs = {}
    datasets = payload.get("datasets") or []
    if datasets:
        kwargs["datasets"] = datasets
    if user:
        kwargs["user"] = user

    results = await cognee.recall(payload.get("query", ""), **kwargs)
    return [
        {
            "title": getattr(item, "title", None) or "Cognee result",
            "body": result_to_text(item),
            "source": result_to_source(item),
            "score": getattr(item, "score", None),
        }
        for item in (results or [])[:5]
    ]


async def improve(payload):
    import cognee

    await ensure_database()
    doc = payload.get("document") or {}
    user = await get_user(doc.get("userEmail"))
    dataset_name = doc.get("datasetName")

    await remember({"documents": [doc]})
    if hasattr(cognee, "improve"):
        kwargs = {}
        if dataset_name:
            kwargs["dataset_name"] = dataset_name
        if user:
            kwargs["user"] = user
        try:
            await cognee.improve(**kwargs)
        except TypeError:
            await cognee.improve()
    return {"provider": "cognee", "improved": True}


async def share(payload):
    await ensure_database()

    from cognee.modules.data.methods import get_authorized_existing_datasets
    from cognee.modules.users.permissions.methods import authorized_give_permission_on_datasets

    owner = await get_user(payload.get("ownerEmail"))
    target = await get_user(payload.get("targetEmail"))
    if not owner or not target:
        return {"provider": "cognee", "shared": False, "reason": "user helper unavailable"}

    datasets = await get_authorized_existing_datasets([payload["datasetName"]], "share", owner)
    await authorized_give_permission_on_datasets(target.id, [item.id for item in datasets], "read", owner.id)
    return {
        "provider": "cognee",
        "shared": True,
        "datasetName": payload["datasetName"],
        "ownerEmail": payload.get("ownerEmail"),
        "targetEmail": payload.get("targetEmail"),
    }


async def main():
    command = sys.argv[1]
    payload = json.loads(sys.stdin.read() or "{}")
    commands = {
        "remember": remember,
        "recall": recall,
        "improve": improve,
        "share": share,
    }
    if command not in commands:
        raise SystemExit(f"Unknown command: {command}")
    print(json.dumps(await commands[command](payload)))


if __name__ == "__main__":
    asyncio.run(main())
