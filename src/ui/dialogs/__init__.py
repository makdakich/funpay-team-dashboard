"""UI dialogs package."""

from .profile_dialogs import NewProfileDialog, RenameProfileDialog
from .variable_dialog import VariableInputDialog
from .test_preview_dialog import TestPreviewDialog
from .quick_menu_dialog import QuickMenuDialog
from .settings_dialog import SettingsDialog

__all__ = [
    "NewProfileDialog",
    "RenameProfileDialog",
    "VariableInputDialog",
    "TestPreviewDialog",
    "QuickMenuDialog",
    "SettingsDialog",
]
