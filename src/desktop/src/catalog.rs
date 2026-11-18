//! The providers, models and effort options the server reports (`getConfig`),
//! and the rules the TUI's model picker follows with them: which providers
//! and models are offered, how a model's name and effort read, and what a
//! switch keeps. Ports of `core/catalog/summary.ts`, `tui/model/display.ts`
//! and `tui/model/continue.ts`; the data comes from the source, so the same
//! picker serves the mock's fixtures and the real server.

use crate::usage::ProviderLimits;
use serde_json::{Value, json};
use std::collections::HashSet;

/// One value of a model's option (a reasoning level, a context size).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub id: String,
    pub label: String,
    pub default: bool,
}

/// A select-type option of a model, e.g. its reasoning effort.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Knob {
    pub id: String,
    pub label: String,
    pub choices: Vec<Choice>,
    /// The value the catalog says is in force when none is chosen.
    pub current: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelInfo {
    pub slug: String,
    pub name: String,
    pub default: bool,
    /// Hidden from the picker by the user's `providerModelPreferences`. Not an
    /// entitlement check: a hidden model can still be chosen elsewhere.
    pub hidden: bool,
    pub knobs: Vec<Knob>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Provider {
    pub instance: String,
    pub driver: String,
    pub name: String,
    pub enabled: bool,
    pub installed: bool,
    /// The server's own words ("Run codex login").
    pub status: Option<String>,
    pub auth: Option<String>,
    pub models: Vec<ModelInfo>,
    /// The subscription windows the driver last reported for this provider
    /// (`usageLimits` in `ProviderSummary`), so the usage control has
    /// something to show before any session reports.
    pub usage_limits: Option<ProviderLimits>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Catalog {
    pub providers: Vec<Provider>,
}

/// Whether the catalog has arrived.
#[derive(Clone, Debug)]
pub enum CatalogState {
    Loading,
    Ready(std::sync::Arc<Catalog>),
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OptionValue {
    Text(String),
    Flag(bool),
}

/// A thread's model: `modelSelection` on the wire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    pub instance: String,
    pub model: String,
    pub options: Vec<(String, OptionValue)>,
}

impl Selection {
    /// Whether a continuation still names the current model and its options.
    pub fn same_as(&self, other: &Self) -> bool {
        if self.instance != other.instance || self.model != other.model {
            return false;
        }
        let mut left: Vec<_> = self.options.iter().collect();
        let mut right: Vec<_> = other.options.iter().collect();
        left.sort_by(|a, b| a.0.cmp(&b.0));
        right.sort_by(|a, b| a.0.cmp(&b.0));
        left == right
    }

    pub fn from_json(value: &Value) -> Option<Self> {
        let instance = nonempty(&value["instanceId"])?;
        let model = nonempty(&value["model"])?;
        let options = value["options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|option| {
                let id = nonempty(&option["id"])?;
                let value = match &option["value"] {
                    Value::String(text) => OptionValue::Text(text.clone()),
                    Value::Bool(flag) => OptionValue::Flag(*flag),
                    _ => return None,
                };
                Some((id, value))
            })
            .collect();
        Some(Self {
            instance,
            model,
            options,
        })
    }

    pub fn to_json(&self) -> Value {
        let mut value = json!({ "instanceId": self.instance, "model": self.model });
        if !self.options.is_empty() {
            value["options"] = self
                .options
                .iter()
                .map(|(id, option)| {
                    let option = match option {
                        OptionValue::Text(text) => json!(text),
                        OptionValue::Flag(flag) => json!(flag),
                    };
                    json!({ "id": id, "value": option })
                })
                .collect();
        }
        value
    }

    fn text(&self, id: &str) -> Option<&str> {
        self.options.iter().find_map(|(option, value)| match value {
            OptionValue::Text(text) if option == id => Some(text.as_str()),
            _ => None,
        })
    }

    /// The same model with `id` set to `value`.
    pub fn with_option(&self, id: &str, value: &str) -> Self {
        let mut next = self.clone();
        next.options.retain(|(option, _)| option != id);
        next.options
            .push((id.to_string(), OptionValue::Text(value.to_string())));
        next
    }
}

fn nonempty(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string)
}

/// Whether a knob is a reasoning level, as opposed to a display-only select
/// like a context window. Defaults attach and resolve only on these.
pub fn is_effort(id: &str) -> bool {
    let id = id.to_lowercase();
    ["effort", "reasoning", "thinking"]
        .iter()
        .any(|word| id.contains(word))
}

/// The level that applies when none is chosen: `medium` when offered, else the
/// middle one.
fn default_effort(knob: &Knob) -> Option<&Choice> {
    knob.choices
        .iter()
        .find(|choice| choice.id == "medium")
        .or_else(|| knob.choices.get(knob.choices.len().saturating_sub(1) / 2))
}

impl Catalog {
    /// Reads a `getConfig` answer; `None` when it is not one.
    pub fn from_config(config: &Value) -> Option<Self> {
        let providers = config["providers"].as_array()?;
        Some(Self {
            providers: providers
                .iter()
                .filter_map(|provider| provider_of(provider, &config["settings"]))
                .collect(),
        })
    }

    pub fn provider(&self, instance: &str) -> Option<&Provider> {
        self.providers.iter().find(|p| p.instance == instance)
    }

    pub fn model(&self, selection: &Selection) -> Option<&ModelInfo> {
        self.provider(&selection.instance)?
            .models
            .iter()
            .find(|m| m.slug == selection.model)
    }

    /// The providers a new thread may start on: only enabled ones. A disabled
    /// provider still lists its models, but choosing it fails.
    pub fn offerable(&self) -> impl Iterator<Item = &Provider> {
        self.providers.iter().filter(|p| p.enabled)
    }

    /// The model's name, never the raw slug once the catalog is known.
    pub fn model_name(&self, selection: &Selection) -> String {
        self.model(selection)
            .map_or_else(|| prettify(&selection.model), |m| m.name.clone())
    }

    /// The display name of a bare model slug, for readings that carry no
    /// instance (the stats screen's favorite model): the catalog's name
    /// where known, a readable form of the slug until then.
    pub fn display_name(&self, slug: &str) -> String {
        self.providers
            .iter()
            .flat_map(|provider| provider.models.iter())
            .find(|model| model.slug == slug)
            .map_or_else(|| prettify(slug), |model| model.name.clone())
    }

    /// The reasoning level beside the name: the chosen one, else the model's
    /// default, so the knob never reads blank.
    pub fn effort_label(&self, selection: &Selection) -> Option<String> {
        let Some(model) = self.model(selection) else {
            // Unknown model: whatever effort-like option the selection carries.
            let texts = selection
                .options
                .iter()
                .filter_map(|(id, value)| match value {
                    OptionValue::Text(text) => Some((id, text)),
                    OptionValue::Flag(_) => None,
                });
            let texts: Vec<_> = texts.collect();
            return texts
                .iter()
                .find(|(id, _)| is_effort(id))
                .or(texts.first())
                .map(|(_, text)| (*text).clone());
        };
        model
            .knobs
            .iter()
            .find_map(|knob| knob_value(knob, selection).map(|id| label_of(knob, &id)))
    }

    /// What a switch to `provider`'s `model` keeps of `base`: flags always; a
    /// text option only when the new model offers that value; levels the new
    /// model has but `base` lacks land on their default, so a send carries a
    /// real value and the footer never reads blank.
    pub fn rebase(&self, base: Option<&Selection>, instance: &str, model: &str) -> Selection {
        let info = self
            .provider(instance)
            .and_then(|p| p.models.iter().find(|m| m.slug == model));
        let mut options: Vec<(String, OptionValue)> = base
            .into_iter()
            .flat_map(|base| base.options.iter())
            .filter(|(id, value)| match value {
                OptionValue::Flag(_) => true,
                OptionValue::Text(text) => info.is_some_and(|info| {
                    info.knobs.iter().any(|knob| {
                        knob.id == *id && knob.choices.iter().any(|choice| choice.id == *text)
                    })
                }),
            })
            .cloned()
            .collect();
        for knob in info.map_or(&[][..], |info| &info.knobs[..]) {
            if !is_effort(&knob.id) || options.iter().any(|(id, _)| *id == knob.id) {
                continue;
            }
            if let Some(choice) = default_effort(knob) {
                options.push((knob.id.clone(), OptionValue::Text(choice.id.clone())));
            }
        }
        Selection {
            instance: instance.into(),
            model: model.into(),
            options,
        }
    }
}

impl Provider {
    /// The models the picker lists: all but the user's hidden ones, except the
    /// current one, which stays so a since-hidden choice still shows.
    pub fn offerable_models<'a>(
        &'a self,
        current: Option<&'a str>,
    ) -> impl Iterator<Item = &'a ModelInfo> {
        self.models
            .iter()
            .filter(move |m| !m.hidden || Some(m.slug.as_str()) == current)
    }

    /// Why a model of this provider cannot be started, if it cannot.
    pub fn unavailable(&self) -> Option<String> {
        if !self.installed {
            return Some(
                self.status
                    .clone()
                    .unwrap_or_else(|| "Not installed".into()),
            );
        }
        (self.auth.as_deref() == Some("unauthenticated")).then(|| {
            self.status
                .clone()
                .unwrap_or_else(|| "Not signed in".into())
        })
    }
}

impl ModelInfo {
    /// The range of reasoning levels the model takes ("Low–Max"); one level
    /// alone, nothing for a model with none.
    pub fn effort_range(&self) -> Option<String> {
        let levels: Vec<&str> = self
            .knobs
            .iter()
            .filter(|knob| is_effort(&knob.id))
            .flat_map(|knob| knob.choices.iter().map(|choice| choice.label.as_str()))
            .collect();
        match levels.as_slice() {
            [] => None,
            [only] => Some((*only).into()),
            [first, .., last] => Some(format!("{first}–{last}")),
        }
    }
}

/// The value in force for a knob: the chosen one, else the catalog's current
/// or default, else (for a reasoning level) the enforced default.
pub fn knob_value(knob: &Knob, selection: &Selection) -> Option<String> {
    selection
        .text(&knob.id)
        .map(str::to_string)
        .or_else(|| knob.current.clone())
        .or_else(|| {
            knob.choices
                .iter()
                .find(|choice| choice.default)
                .map(|choice| choice.id.clone())
        })
        .or_else(|| {
            is_effort(&knob.id)
                .then(|| default_effort(knob).map(|choice| choice.id.clone()))
                .flatten()
        })
}

fn label_of(knob: &Knob, id: &str) -> String {
    knob.choices
        .iter()
        .find(|choice| choice.id == id)
        .map_or_else(|| id.to_string(), |choice| choice.label.clone())
}

/// A readable name for a slug the catalog does not know:
/// `opencode/space-bunny-free` reads "Space Bunny Free".
pub fn prettify(slug: &str) -> String {
    let tail = slug.rsplit('/').next().unwrap_or(slug);
    let words: Vec<String> = tail
        .split(['-', '_'])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            let first = chars.next().unwrap_or_default();
            let numeric = first.is_ascii_digit()
                || (matches!(first, 'v' | 'V')
                    && chars.clone().next().is_some_and(|c| c.is_ascii_digit()))
                || (matches!(first, 'x' | 'X')
                    && chars.clone().next().is_some_and(|c| c.is_ascii_digit()));
            if numeric {
                word.to_string()
            } else {
                first.to_uppercase().chain(chars).collect()
            }
        })
        .collect();
    if words.is_empty() {
        slug.to_string()
    } else {
        words.join(" ")
    }
}

/// The token a provider's name and mark are drawn in.
pub fn provider_color(driver: &str, instance: &str) -> &'static str {
    let haystack = format!("{driver} {instance}").to_lowercase();
    if haystack.contains("claude") {
        "provider-claude"
    } else if haystack.contains("opencode") {
        "provider-opencode"
    } else {
        "ink"
    }
}

fn provider_of(raw: &Value, settings: &Value) -> Option<Provider> {
    let instance = nonempty(&raw["instanceId"])?;
    let driver = nonempty(&raw["driver"])?;
    let hidden: HashSet<&str> = settings["providerModelPreferences"][&instance]["hiddenModels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    Some(Provider {
        name: nonempty(&raw["displayName"]).unwrap_or_else(|| instance.clone()),
        enabled: raw["enabled"].as_bool().unwrap_or(false),
        installed: raw["installed"].as_bool().unwrap_or(false),
        status: nonempty(&raw["status"]),
        auth: nonempty(&raw["auth"]["status"]),
        usage_limits: if raw["usageLimits"].is_null() {
            None
        } else {
            Some(ProviderLimits::from_json(&raw["usageLimits"]))
        },
        models: raw["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|model| model_of(model, &hidden))
            .collect(),
        instance,
        driver,
    })
}

fn model_of(raw: &Value, hidden: &HashSet<&str>) -> Option<ModelInfo> {
    let slug = nonempty(&raw["slug"])?;
    let name = nonempty(&raw["name"])?;
    Some(ModelInfo {
        knobs: raw["capabilities"]["optionDescriptors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(knob_of)
            .collect(),
        default: raw["isDefault"].as_bool().unwrap_or(false),
        hidden: hidden.contains(slug.as_str()),
        slug,
        name,
    })
}

/// Only select-type options list values; flags are left out.
fn knob_of(raw: &Value) -> Option<Knob> {
    if raw["type"] != "select" {
        return None;
    }
    Some(Knob {
        id: nonempty(&raw["id"])?,
        label: nonempty(&raw["label"])?,
        choices: raw["options"]
            .as_array()?
            .iter()
            .filter_map(|choice| {
                Some(Choice {
                    id: nonempty(&choice["id"])?,
                    label: nonempty(&choice["label"])?,
                    default: choice["isDefault"].as_bool().unwrap_or(false),
                })
            })
            .collect(),
        current: nonempty(&raw["currentValue"]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Value {
        json!({
            "providers": [
                {
                    "instanceId": "claudeAgent", "driver": "claudeAgent",
                    "displayName": "Claude Code", "enabled": true, "installed": true,
                    "auth": { "status": "authenticated" },
                    "models": [
                        {
                            "slug": "opus", "name": "Opus 5.5", "isCustom": false, "isDefault": true,
                            "capabilities": { "optionDescriptors": [
                                { "id": "effort", "label": "Effort", "type": "select",
                                  "options": [
                                    { "id": "low", "label": "Low" },
                                    { "id": "high", "label": "High" },
                                    { "id": "max", "label": "Max" }
                                  ] },
                                { "id": "fastMode", "label": "Fast", "type": "boolean" }
                            ] }
                        },
                        { "slug": "haiku", "name": "Haiku 4.5", "isCustom": false,
                          "capabilities": { "optionDescriptors": [
                            { "id": "effort", "label": "Effort", "type": "select",
                              "options": [ { "id": "low", "label": "Low" }, { "id": "high", "label": "High" } ] }
                          ] } },
                        { "slug": "old", "name": "Old", "isCustom": false }
                    ]
                },
                {
                    "instanceId": "codex", "driver": "codex", "displayName": null,
                    "enabled": false, "installed": true, "auth": { "status": "unauthenticated" },
                    "status": "Run codex login",
                    "models": [ { "slug": "gpt", "name": "GPT", "isCustom": false } ]
                }
            ],
            "settings": { "providerModelPreferences": { "claudeAgent": { "hiddenModels": ["old"] } } }
        })
    }

    fn select(model: &str, options: &[(&str, &str)]) -> Selection {
        Selection {
            instance: "claudeAgent".into(),
            model: model.into(),
            options: options
                .iter()
                .map(|(id, v)| ((*id).into(), OptionValue::Text((*v).into())))
                .collect(),
        }
    }

    #[test]
    fn reads_providers_models_efforts_and_hidden_models() {
        let catalog = Catalog::from_config(&config()).unwrap();
        assert_eq!(catalog.providers.len(), 2);
        let claude = &catalog.providers[0];
        assert_eq!(claude.name, "Claude Code");
        // Only select-type options are knobs.
        assert_eq!(claude.models[0].knobs.len(), 1);
        assert!(claude.models[0].default);
        assert!(claude.models[2].hidden);
        assert_eq!(catalog.providers[1].name, "codex");
    }

    #[test]
    fn offers_enabled_providers_and_hides_models_except_the_current_one() {
        let catalog = Catalog::from_config(&config()).unwrap();
        let offered: Vec<_> = catalog.offerable().map(|p| p.instance.as_str()).collect();
        assert_eq!(offered, ["claudeAgent"]);
        let claude = catalog.provider("claudeAgent").unwrap();
        let names = |current| {
            claude
                .offerable_models(current)
                .map(|m| m.slug.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(None), ["opus", "haiku"]);
        assert_eq!(names(Some("old")), ["opus", "haiku", "old"]);
    }

    #[test]
    fn bare_slugs_resolve_to_display_names() {
        // The stats screen's favorite model carries no instance: the name
        // comes from wherever the catalog knows the slug.
        let catalog = Catalog::from_config(&config()).unwrap();
        assert_eq!(catalog.display_name("opus"), "Opus 5.5");
        assert_eq!(catalog.display_name("space-bunny-free"), "Space Bunny Free");
        // A slug the catalog does not know reads like the picker does.
        assert_eq!(catalog.display_name("mystery-model"), "Mystery Model");
    }

    #[test]
    fn a_provider_that_cannot_start_says_why() {
        let catalog = Catalog::from_config(&config()).unwrap();
        assert_eq!(catalog.provider("claudeAgent").unwrap().unavailable(), None);
        assert_eq!(
            catalog.provider("codex").unwrap().unavailable().as_deref(),
            Some("Run codex login")
        );
    }

    #[test]
    fn names_and_levels_read_like_the_tui() {
        let catalog = Catalog::from_config(&config()).unwrap();
        assert_eq!(catalog.model_name(&select("opus", &[])), "Opus 5.5");
        assert_eq!(
            catalog.model_name(&select("space-bunny-free", &[])),
            "Space Bunny Free"
        );
        assert_eq!(
            catalog
                .effort_label(&select("opus", &[("effort", "max")]))
                .as_deref(),
            Some("Max")
        );
        // No level chosen: the middle one, as `defaultEffortChoice` picks.
        assert_eq!(
            catalog.effort_label(&select("opus", &[])).as_deref(),
            Some("High")
        );
        assert_eq!(catalog.effort_label(&select("old", &[])), None);
        assert_eq!(
            catalog
                .model(&select("opus", &[]))
                .unwrap()
                .effort_range()
                .as_deref(),
            Some("Low–Max")
        );
    }

    #[test]
    fn switching_models_keeps_only_what_still_applies() {
        let catalog = Catalog::from_config(&config()).unwrap();
        let mut base = select("opus", &[("effort", "max")]);
        base.options
            .push(("fastMode".into(), OptionValue::Flag(true)));
        // Haiku has no `max`: the level falls to its default, the flag stays.
        let next = catalog.rebase(Some(&base), "claudeAgent", "haiku");
        assert_eq!(next.text("effort"), Some("low"));
        assert!(
            next.options
                .contains(&("fastMode".into(), OptionValue::Flag(true)))
        );
        // A value both models offer survives.
        let base = select("opus", &[("effort", "high")]);
        assert_eq!(
            catalog
                .rebase(Some(&base), "claudeAgent", "haiku")
                .text("effort"),
            Some("high")
        );
        // A model with no knobs gets none, and nothing blank is written.
        assert!(
            catalog
                .rebase(Some(&base), "claudeAgent", "old")
                .options
                .is_empty()
        );
    }

    #[test]
    fn a_selection_round_trips_the_wire_shape() {
        let wire = json!({
            "instanceId": "claudeAgent", "model": "opus",
            "options": [ { "id": "effort", "value": "high" }, { "id": "fastMode", "value": false } ]
        });
        let selection = Selection::from_json(&wire).unwrap();
        assert_eq!(selection.to_json(), wire);
        assert_eq!(
            selection.with_option("effort", "max").text("effort"),
            Some("max")
        );
        assert_eq!(Selection::from_json(&json!({ "model": "x" })), None);
    }
}
