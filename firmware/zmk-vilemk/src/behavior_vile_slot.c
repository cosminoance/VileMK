/*
 * Part of VileMK; see LICENSE at the repository root.
 *
 * `&vslot N` runs whatever binding sits at position N of the slots layer, so
 * ZMK Studio can change it with set_layer_binding and no flash.
 */

#define DT_DRV_COMPAT zmk_behavior_vile_slot

#include <string.h>
#include <zephyr/device.h>
#include <drivers/behavior.h>
#include <zephyr/logging/log.h>

#include <zmk/behavior.h>
#include <zmk/keymap.h>
#include <zmk/matrix.h>

LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#if DT_HAS_COMPAT_STATUS_OKAY(DT_DRV_COMPAT)

#define VSLOT_HELD_MAX 16

struct vslot_config {
    uint8_t layer;
};

/* What each press ran, so its release runs the same binding even if the slot
 * changed while the key was down. */
struct vslot_held {
    bool used;
    uint32_t position;
    uint32_t slot;
    struct zmk_behavior_binding binding;
};

static struct vslot_held held[VSLOT_HELD_MAX];

#if IS_ENABLED(CONFIG_ZMK_BEHAVIOR_METADATA)

static const struct behavior_parameter_value_metadata param_values[] = {
    {
        .display_name = "Slot",
        .type = BEHAVIOR_PARAMETER_VALUE_TYPE_RANGE,
        .range = {.min = 0, .max = ZMK_KEYMAP_LEN - 1},
    },
};

static const struct behavior_parameter_metadata_set param_metadata_set[] = {{
    .param1_values = param_values,
    .param1_values_len = ARRAY_SIZE(param_values),
}};

static const struct behavior_parameter_metadata metadata = {
    .sets_len = ARRAY_SIZE(param_metadata_set),
    .sets = param_metadata_set,
};

#endif

static int on_pressed(struct zmk_behavior_binding *binding,
                      struct zmk_behavior_binding_event event) {
    const struct device *dev = zmk_behavior_get_binding(binding->behavior_dev);
    const struct vslot_config *cfg = dev->config;
    const struct zmk_behavior_binding *slot =
        zmk_keymap_get_layer_binding_at_idx(cfg->layer, binding->param1);

    if (slot == NULL || slot->behavior_dev == NULL) {
        return ZMK_BEHAVIOR_OPAQUE;
    }
    // A slot pointing back at a slot could recurse without end.
    if (strcmp(slot->behavior_dev, binding->behavior_dev) == 0) {
        LOG_WRN("slot %d holds &vslot; ignored", binding->param1);
        return ZMK_BEHAVIOR_OPAQUE;
    }
    for (int i = 0; i < VSLOT_HELD_MAX; i++) {
        if (!held[i].used) {
            held[i] = (struct vslot_held){.used = true,
                                          .position = event.position,
                                          .slot = binding->param1,
                                          .binding = *slot};
            return zmk_behavior_invoke_binding(&held[i].binding, event, true);
        }
    }
    LOG_WRN("more than %d slots held at once", VSLOT_HELD_MAX);
    return ZMK_BEHAVIOR_OPAQUE;
}

static int on_released(struct zmk_behavior_binding *binding,
                       struct zmk_behavior_binding_event event) {
    for (int i = 0; i < VSLOT_HELD_MAX; i++) {
        if (held[i].used && held[i].position == event.position &&
            held[i].slot == binding->param1) {
            held[i].used = false;
            return zmk_behavior_invoke_binding(&held[i].binding, event, false);
        }
    }
    return ZMK_BEHAVIOR_OPAQUE;
}

static const struct behavior_driver_api vslot_driver_api = {
    .binding_pressed = on_pressed,
    .binding_released = on_released,
#if IS_ENABLED(CONFIG_ZMK_BEHAVIOR_METADATA)
    .parameter_metadata = &metadata,
#endif
};

#define VSLOT_INST(n)                                                                              \
    static const struct vslot_config vslot_config_##n = {.layer = DT_INST_PROP(n, layer)};        \
    BEHAVIOR_DT_INST_DEFINE(n, NULL, NULL, NULL, &vslot_config_##n, POST_KERNEL,                   \
                            CONFIG_KERNEL_INIT_PRIORITY_DEFAULT, &vslot_driver_api);

DT_INST_FOREACH_STATUS_OKAY(VSLOT_INST)

#endif
