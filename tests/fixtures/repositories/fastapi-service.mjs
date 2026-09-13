/**
 * Evaluation fixture: a Python FastAPI service with SQLAlchemy models.
 *
 * Covers the cases Python extraction gets wrong most easily - stacked decorators, where
 * the route decorator is not the line above the function, and a documented route that
 * only exists in a docstring.
 */
export const repository = {
  name: "fastapi-service",
  description: "Python service: APIRouter decorators, SQLAlchemy entities, pyproject.",

  files: {
    "pyproject.toml": `[project]
name = "billing-service"
version = "0.4.1"
requires-python = ">=3.11"
dependencies = ["fastapi>=0.115", "sqlalchemy>=2.0", "httpx>=0.27"]

[dependency-groups]
dev = ["pytest>=8.0", "ruff>=0.7"]

[tool.pytest.ini_options]
testpaths = ["tests"]
`,

    "Makefile": `run:
\tuvicorn app.main:app --reload

test:
\tpytest

lint:
\truff check .
`,

    "app/api/webhooks.py": `from fastapi import APIRouter

from app.tracing import traced

router = APIRouter(prefix="/webhooks")


@router.post("/stripe")
@traced("api.webhooks.stripe")
def handle_stripe(payload: dict):
    """Handle a Stripe webhook.

    An older revision exposed @router.post("/legacy-stripe") here.
    """
    return persist_event(payload)


@router.get("/health")
def health():
    return {"ok": True}


def persist_event(payload: dict):
    return payload
`,

    "app/models.py": `from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[int] = mapped_column(primary_key=True)
    amount_cents: Mapped[int] = mapped_column()


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
`,

    "app/tracing.py": `def traced(name):
    def decorate(fn):
        return fn

    return decorate
`,

    "tests/test_webhooks.py": `from app.api.webhooks import handle_stripe


def test_handle_stripe():
    assert handle_stripe({}) == {}
`,
  },

  expect: {
    routes: {
      // The stacked-decorator case: @traced sits between the route decorator and the
      // function, so a fixed-offset lookup reads the wrong literal.
      present: ["/stripe", "/health"],
      absent: ["/legacy-stripe"], // mentioned only in a docstring
    },
    dataEntities: { present: ["Invoice", "Customer"], absent: [] },
    dependencies: { present: ["fastapi", "sqlalchemy", "httpx", "pytest", "ruff"] },
    commands: { present: ["run", "test", "lint"] },
    symbols: { present: ["handle_stripe", "health", "persist_event", "Invoice", "Customer"] },
    calls: { present: [["handle_stripe", "persist_event"]] },
    testSuites: { minimum: 1 },
  },
};
