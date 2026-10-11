# Added to ZMK's `app` target, which carries ZMK's own include paths.
target_sources_ifdef(CONFIG_ZMK_BEHAVIOR_VILE_SLOT app PRIVATE src/behavior_vile_slot.c)
