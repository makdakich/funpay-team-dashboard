"""Variable extraction, substitution, type validation, and presets."""

import re
from dataclasses import dataclass
from typing import List, Dict, Optional, Tuple
from ..database.db import Database

# Matches {name} or {name:type}, e.g. {robux}, {robux:number}, {price:price}
VAR_REGEX = re.compile(r"\{([a-zA-Z0-9_а-яА-ЯёЁ]+)(?::([a-zA-Z0-9_]+))?\}")

DEFAULT_PRESETS: Dict[str, List[str]] = {
    "robux": ["100", "500", "1000", "2500", "5000", "10000"],
    "price": ["50", "100", "250", "500", "1000", "2000"],
    "amount": ["1", "5", "10", "25", "50", "100"],
    "count": ["1", "2", "3", "5", "10"],
}


@dataclass
class VariableDefinition:
    name: str
    var_type: str  # 'text', 'number', 'price'
    raw_tag: str

    @property
    def display_label(self) -> str:
        type_hint = f" ({self.var_type})" if self.var_type != "text" else ""
        return f"{self.name}{type_hint}"


class VariableManager:
    def __init__(self, db: Optional[Database] = None):
        self.db = db

    def extract_variable_definitions(self, text: str) -> List[VariableDefinition]:
        """
        Extract unique variable definitions with type info.
        E.g. {robux:number} -> VariableDefinition(name='robux', var_type='number', raw_tag='{robux:number}')
        """
        if not text:
            return []

        results: List[VariableDefinition] = []
        seen = set()

        for match in VAR_REGEX.finditer(text):
            name = match.group(1).strip()
            explicit_type = match.group(2)
            raw = match.group(0)

            if not name:
                continue

            low_name = name.lower()
            if low_name in seen:
                continue
            seen.add(low_name)

            # Determine type
            if explicit_type:
                var_type = explicit_type.strip().lower()
            else:
                # Infer type by common names
                if low_name in ("robux", "count", "amount", "кол-во", "количество", "number"):
                    var_type = "number"
                elif low_name in ("price", "цена", "стоимость", "сумма"):
                    var_type = "price"
                else:
                    var_type = "text"

            results.append(VariableDefinition(name=name, var_type=var_type, raw_tag=raw))

        return results

    def extract_variables(self, text: str) -> List[str]:
        """
        Backward-compatible: extract unique variable names (e.g. ['robux', 'price']).
        """
        defs = self.extract_variable_definitions(text)
        return [d.name for d in defs]

    def has_variables(self, text: str) -> bool:
        return bool(VAR_REGEX.search(text)) if text else False

    def validate_value(self, var_type: str, value: str) -> Tuple[bool, str]:
        """
        Validate variable value against its declared type.
        Returns (is_valid, error_message).
        """
        val = value.strip()
        if not val:
            return True, ""  # Empty is handled by required check if needed

        if var_type == "number":
            if not val.isdigit():
                return False, "Значение должно содержать только цифры"
        elif var_type == "price":
            # Allow digits, optional comma or dot with 1-2 decimal places
            clean = val.replace(",", ".")
            try:
                num = float(clean)
                if num < 0:
                    return False, "Цена не может быть отрицательной"
            except ValueError:
                return False, "Введите корректное число или цену (например 150 или 150.50)"

        return True, ""

    def substitute(self, text: str, values: Dict[str, str]) -> str:
        """
        Substitute {name} or {name:type} in text with provided values.
        Matches keys case-insensitively.
        """
        if not text:
            return ""

        lower_values = {k.strip().lower(): str(v) for k, v in values.items()}

        def replacer(match):
            var_name = match.group(1).strip().lower()
            if var_name in lower_values:
                return lower_values[var_name]
            return match.group(0)

        return VAR_REGEX.sub(replacer, text)

    def get_quick_values(self, var_name: str, limit: int = 6) -> List[str]:
        """
        Get quick values for a variable. Combines database history with predefined presets.
        """
        name_key = var_name.lower().strip()
        history_vals = []
        if self.db:
            history_vals = self.db.get_variable_recent_values(name_key, limit=limit)

        presets = DEFAULT_PRESETS.get(name_key, [])
        combined = []
        seen = set()

        # Database history first (recently used)
        for v in history_vals:
            if v not in seen:
                seen.add(v)
                combined.append(v)

        # Then standard presets
        for v in presets:
            if v not in seen and len(combined) < limit:
                seen.add(v)
                combined.append(v)

        return combined

    def record_used_values(self, values: Dict[str, str]) -> None:
        """Save recently used variable values to database for history."""
        if not self.db:
            return
        for var_name, val in values.items():
            clean_val = str(val).strip()
            if clean_val:
                self.db.add_variable_value(var_name, clean_val)
