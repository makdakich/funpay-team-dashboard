"""Tests for VariableManager."""

import pytest
from src.core.variable_manager import VariableManager
from src.database.db import Database


@pytest.fixture
def var_mgr(tmp_path):
    db = Database(str(tmp_path / "test_var.db"))
    return VariableManager(db)


def test_extract_variables(var_mgr):
    template = "Привет, {buyer}! Ваш заказ на {robux} Robux готов. Цена: {price} руб. Повтор: {robux}."
    vars_found = var_mgr.extract_variables(template)
    assert vars_found == ["buyer", "robux", "price"]


def test_has_variables(var_mgr):
    assert var_mgr.has_variables("Простой текст без переменных") is False
    assert var_mgr.has_variables("Текст с {var}") is True


def test_substitute(var_mgr):
    template = "Заказ {order} от {buyer}: {robux} R$ за {price} руб."
    values = {
        "order": "#12345",
        "buyer": "Alex",
        "robux": "5000",
        "price": "2400",
    }
    result = var_mgr.substitute(template, values)
    assert result == "Заказ #12345 от Alex: 5000 R$ за 2400 руб."


def test_substitute_partial(var_mgr):
    template = "Привет {user}, ваш баланс {amount}!"
    values = {"user": "Max"}
    result = var_mgr.substitute(template, values)
    assert result == "Привет Max, ваш баланс {amount}!"


def test_quick_values_and_history(var_mgr):
    # Pre-seeded or default presets
    quick = var_mgr.get_quick_values("robux", limit=5)
    assert len(quick) > 0

    # Record custom value
    var_mgr.record_used_values({"robux": "15000", "buyer": "SuperGamer"})
    updated_quick = var_mgr.get_quick_values("robux", limit=5)
    assert "15000" in updated_quick
