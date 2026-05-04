from typer.testing import CliRunner

from kb.cli import app

runner = CliRunner()


def test_compile_exits_with_error_when_not_implemented():
    result = runner.invoke(app, ["compile"])
    assert result.exit_code == 1
    assert "not yet implemented" in result.output


def test_ask_exits_with_error_when_not_implemented():
    result = runner.invoke(app, ["ask", "vem är Jonas?"])
    assert result.exit_code == 1
    assert "not yet implemented" in result.output


def test_lint_exits_with_error_when_not_implemented():
    result = runner.invoke(app, ["lint"])
    assert result.exit_code == 1
    assert "not yet implemented" in result.output


def test_help_exits_cleanly():
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "compile" in result.output
    assert "ask" in result.output
    assert "lint" in result.output
