import json
from pathlib import Path

import httpx
from fastapi import FastAPI

from omnigent.server import skill_marketplace as service
from omnigent.server.routes.skill_marketplace import create_skill_marketplace_router


def _catalog_item() -> dict[str, object]:
    return {
        "id": "acme-finance-dcf",
        "name": "dcf-model",
        "author": "acme-finance",
        "description": "Build an evidence-backed DCF valuation model.",
        "githubUrl": "https://github.com/acme-finance/skills/tree/main/dcf-model",
        "skillUrl": "https://skillsmp.com/acme-finance/dcf-model",
        "stars": 42,
        "updatedAt": 1_780_000_000,
    }


class _FakeMarketplaceClient:
    def __init__(self) -> None:
        self.item = _catalog_item()

    async def search(
        self,
        query: str,
        *,
        page: int,
        limit: int,
        language: str | None,
    ) -> dict[str, object]:
        del language
        return {
            "skills": [dict(self.item)],
            "page": page,
            "limit": limit,
            "hasNext": False,
            "total": 1,
            "source": "skillsmp",
            "warning": None,
        }

    def catalog_item(self, marketplace_id: str) -> dict[str, object] | None:
        return dict(self.item) if marketplace_id == self.item["id"] else None


class _HeaderAuth:
    def get_user_id(self, request) -> str | None:
        return request.headers.get("x-test-user")


class _NamespaceStore:
    def get_or_create_data_namespace(self, user_id: str) -> str:
        return f"namespace-{user_id}"


def _write_skill(path: Path, *, name: str = "dcf-model") -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: Build a tested DCF model.\n---\n\n# DCF\n",
        encoding="utf-8",
    )


def test_github_tree_parser_allows_only_public_tree_directories() -> None:
    assert service.parse_github_tree_url(
        "https://github.com/anthropics/financial-services/tree/main/skills/dcf-model"
    ) == ("anthropics", "financial-services", "main", "skills/dcf-model")

    try:
        service.parse_github_tree_url("https://example.com/owner/repo/tree/main/skills/x")
    except service.SkillMarketplaceError as error:
        assert error.code == "unsupported_source"
    else:  # pragma: no cover - assertion spelling keeps compatibility with old pytest
        raise AssertionError("non-GitHub sources must be rejected")


async def test_download_github_skill_recurses_without_path_escape(tmp_path: Path) -> None:
    skill_md = b"---\nname: dcf-model\ndescription: Build a DCF model.\n---\n"
    reference = b"Use audited assumptions.\n"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/contents/dcf-model"):
            return httpx.Response(
                200,
                json=[
                    {
                        "name": "SKILL.md",
                        "type": "file",
                        "size": len(skill_md),
                        "download_url": "https://raw.githubusercontent.com/acme/skills/main/dcf-model/SKILL.md",
                    },
                    {"name": "references", "type": "dir", "size": 0},
                ],
            )
        if request.url.path.endswith("/contents/dcf-model/references"):
            return httpx.Response(
                200,
                json=[
                    {
                        "name": "method.md",
                        "type": "file",
                        "size": len(reference),
                        "download_url": "https://raw.githubusercontent.com/acme/skills/main/dcf-model/references/method.md",
                    }
                ],
            )
        if request.url.path.endswith("/SKILL.md"):
            return httpx.Response(200, content=skill_md)
        if request.url.path.endswith("/method.md"):
            return httpx.Response(200, content=reference)
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        destination = tmp_path / "download"
        await service.download_github_skill(
            "https://github.com/acme/skills/tree/main/dcf-model",
            destination,
            client=client,
        )

    assert (destination / "SKILL.md").read_bytes() == skill_md
    assert (destination / "references" / "method.md").read_bytes() == reference


async def test_marketplace_routes_install_list_and_uninstall(
    tmp_path: Path,
    monkeypatch,
) -> None:
    root = tmp_path / ".agents" / "skills"
    fake_client = _FakeMarketplaceClient()

    async def fake_download(
        _github_url: str,
        destination: Path,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        del client
        _write_skill(destination)

    monkeypatch.setattr(service, "download_github_skill", fake_download)
    app = FastAPI()
    app.include_router(
        create_skill_marketplace_router(
            marketplace_client=fake_client,
            single_user_skills_root=root,
        ),
        prefix="/v1",
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        search = await client.get("/v1/skills/marketplace", params={"q": "DCF valuation"})
        assert search.status_code == 200
        assert search.json()["skills"][0]["installed"] is False

        install = await client.post(
            "/v1/skills/install", json={"marketplaceId": "acme-finance-dcf"}
        )
        assert install.status_code == 201
        assert install.json()["skill"]["name"] == "dcf-model"
        assert (root / "dcf-model" / "SKILL.md").is_file()
        manifest = json.loads(
            (root / "dcf-model" / service.MANIFEST_FILENAME).read_text(encoding="utf-8")
        )
        assert manifest["marketplaceId"] == "acme-finance-dcf"
        assert len(manifest["contentHash"]) == 64

        installed = await client.get("/v1/skills/installed")
        assert installed.status_code == 200
        assert installed.json()["skills"][0]["managed"] is True

        search_again = await client.get("/v1/skills/marketplace", params={"q": "DCF valuation"})
        assert search_again.json()["skills"][0]["installed"] is True

        removed = await client.delete("/v1/skills/installed/dcf-model")
        assert removed.status_code == 200
        assert removed.json() == {"installId": "dcf-model", "status": "uninstalled"}
        assert not (root / "dcf-model").exists()


async def test_install_requires_a_fresh_server_catalog_item(tmp_path: Path) -> None:
    app = FastAPI()
    app.include_router(
        create_skill_marketplace_router(
            marketplace_client=_FakeMarketplaceClient(),
            single_user_skills_root=tmp_path / "skills",
        ),
        prefix="/v1",
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/v1/skills/install", json={"marketplaceId": "client-forged-id"}
        )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "catalog_item_not_found"


async def test_installed_skills_are_isolated_per_authenticated_user(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("PRIVATE_FUND_USER_DATA_ROOT", str(tmp_path / "users"))

    async def fake_download(
        _github_url: str,
        destination: Path,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        del client
        _write_skill(destination)

    monkeypatch.setattr(service, "download_github_skill", fake_download)
    app = FastAPI()
    app.include_router(
        create_skill_marketplace_router(
            auth_provider=_HeaderAuth(),
            account_store=_NamespaceStore(),
            marketplace_client=_FakeMarketplaceClient(),
        ),
        prefix="/v1",
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        alice = {"x-test-user": "alice"}
        bob = {"x-test-user": "bob"}
        await client.get("/v1/skills/marketplace", params={"q": "DCF"}, headers=alice)
        installed = await client.post(
            "/v1/skills/install",
            json={"marketplaceId": "acme-finance-dcf"},
            headers=alice,
        )
        assert installed.status_code == 201
        assert (await client.get("/v1/skills/installed", headers=alice)).json()["count"] == 1
        assert (await client.get("/v1/skills/installed", headers=bob)).json()["count"] == 0
