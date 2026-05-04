from pathlib import Path

import typer

app = typer.Typer(help="Gemmera — local knowledge base powered by Gemma 4 via Ollama.")

VAULT_DIR = Path(__file__).parent.parent.parent / "vault"
RAW_DIR = VAULT_DIR / "raw"
WIKI_DIR = VAULT_DIR / "wiki"
OUTPUTS_DIR = VAULT_DIR / "outputs"


@app.command()
def compile(
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip preview and write immediately."),
):
    """Read all files in raw/ and build or update wiki pages with [[wikilinks]]."""
    typer.echo("compile: not yet implemented")
    raise typer.Exit(1)


@app.command()
def ask(
    question: str = typer.Argument(..., help="The question to ask about your knowledge base."),
):
    """Answer a question with citations to wiki and raw files."""
    typer.echo("ask: not yet implemented")
    raise typer.Exit(1)


@app.command()
def lint(
    confirm: bool = typer.Option(False, "--confirm", help="Required to allow destructive operations."),
):
    """Find contradictions, orphan pages, and unsourced claims."""
    typer.echo("lint: not yet implemented")
    raise typer.Exit(1)


if __name__ == "__main__":
    app()
