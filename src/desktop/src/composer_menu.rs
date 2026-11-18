use crate::model::{INTERACTION_MODES, Selection, ThreadId};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Destination {
    Thread(ThreadId),
    Project(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Improvement {
    pub destination: Destination,
    pub revision: u64,
    pub directory: String,
    pub selection: Option<Selection>,
    pub original: String,
}

impl Improvement {
    pub fn still_matches(
        &self,
        destination: Option<&Destination>,
        selection: Option<&Selection>,
        directory: Option<&str>,
        revision: u64,
    ) -> bool {
        destination == Some(&self.destination)
            && selection == self.selection.as_ref()
            && directory == Some(self.directory.as_str())
            && revision == self.revision
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub invocation: String,
    pub description: String,
}

#[derive(Default, Debug)]
pub struct Inventory(pub Vec<Choice>);

impl Inventory {
    pub fn decode(value: &Value) -> Result<Self, String> {
        let trigger = match value["trigger"].as_str() {
            Some(trigger @ ("/" | "$")) => trigger,
            _ => return Err("The server did not return a skill inventory.".into()),
        };
        let mut choices: Vec<Choice> = vec![];
        for (kind, prefix) in [("skills", trigger), ("commands", "/")] {
            for item in value[kind].as_array().into_iter().flatten() {
                if kind == "skills" && (item["enabled"] != true || item["userInvocable"] != true) {
                    continue;
                }
                let Some(name) = item["name"]
                    .as_str()
                    .filter(|name| !name.is_empty() && !name.contains(char::is_whitespace))
                else {
                    continue;
                };
                let invocation = format!("{prefix}{name}");
                if !choices.iter().any(|choice| choice.invocation == invocation) {
                    choices.push(Choice {
                        invocation,
                        description: item["shortDescription"]
                            .as_str()
                            .or(item["description"].as_str())
                            .unwrap_or("")
                            .into(),
                    });
                }
            }
        }
        Ok(Self(choices))
    }
}

pub fn slash_prefix(text: &str, cursor: usize) -> Option<(usize, &str)> {
    let before = text.get(..cursor)?;
    let start = before
        .rfind(char::is_whitespace)
        .map_or(0, |at| at + before[at..].chars().next().unwrap().len_utf8());
    let word = &before[start..];
    let (prefix, name) = word.split_at_checked(1)?;
    if !matches!(prefix, "/" | "$")
        || (prefix == "/" && !before[..start].trim().is_empty())
        || !name
            .chars()
            .all(|ch| ch.is_alphanumeric() || "-_.:".contains(ch))
        || text[cursor..]
            .chars()
            .next()
            .is_some_and(|ch| !ch.is_whitespace())
    {
        return None;
    }
    Some((start, word))
}

pub fn choices(prefix: &str, inventory: Option<&Inventory>, busy: bool) -> Vec<Choice> {
    let built_in = INTERACTION_MODES
        .iter()
        .skip(1)
        .filter(|_| !busy)
        .map(|(mode, label)| Choice {
            invocation: format!("/{mode}"),
            description: format!("Use {label} for one prompt"),
        });
    let mut choices: Vec<Choice> = built_in.collect();
    if let Some(inventory) = inventory {
        for choice in &inventory.0 {
            if !choices
                .iter()
                .any(|other| other.invocation == choice.invocation)
            {
                choices.push(choice.clone());
            }
        }
    }
    let dollar = prefix.starts_with('$');
    let query = prefix
        .strip_prefix(['/', '$'])
        .unwrap_or(prefix)
        .to_lowercase();
    let mut scored: Vec<(usize, usize, Choice)> = vec![];
    for (index, choice) in choices.into_iter().enumerate() {
        let choice_dollar = choice.invocation.starts_with('$');
        // Bare "/" still offers the provider's $-skills, as before.
        if choice_dollar != dollar && !(query.is_empty() && !dollar && choice_dollar) {
            continue;
        }
        let rank = if query.is_empty() {
            0
        } else {
            let Some(rank) = rank_choice(&choice, &query) else {
                continue;
            };
            rank
        };
        scored.push((rank, index, choice));
    }
    scored.sort_by_key(|(rank, index, _)| (*rank, *index));
    scored.into_iter().map(|(_, _, choice)| choice).collect()
}

/// Where a query sits for the `/` picker: a name that starts with it, then one
/// that contains it, then a description that does — the TUI's `filterSkills`
/// order, so the most likely pick reads first. `None` matches nothing.
fn rank_choice(choice: &Choice, query: &str) -> Option<usize> {
    let name = choice
        .invocation
        .strip_prefix(['/', '$'])
        .unwrap_or(&choice.invocation)
        .to_lowercase();
    if name.starts_with(query) {
        return Some(0);
    }
    if name.contains(query) {
        return Some(1);
    }
    if choice.description.to_lowercase().contains(query) {
        return Some(2);
    }
    None
}

pub fn mode_command(text: &str) -> Option<(&'static str, &str)> {
    let typed = text.trim().strip_prefix('/')?;
    let (name, rest) = typed.split_once(char::is_whitespace).unwrap_or((typed, ""));
    let mode = INTERACTION_MODES
        .iter()
        .skip(1)
        .find(|(mode, _)| *mode == name)?
        .0;
    Some((mode, rest.trim()))
}

#[cfg(test)]
mod tests {
    use super::{Destination, Improvement, Inventory, choices, mode_command, slash_prefix};
    use serde_json::json;

    #[test]
    fn recognizes_one_off_modes_without_treating_paths_or_other_commands_as_modes() {
        assert_eq!(
            mode_command(" /review\nChanges "),
            Some(("review", "Changes"))
        );
        assert_eq!(mode_command("/research"), Some(("research", "")));
        assert_eq!(
            mode_command("/orchestrate add checks"),
            Some(("orchestrate", "add checks"))
        );
        for input in [
            "/reviewer",
            "/review/notes",
            "use /review",
            "/compact",
            "/default",
        ] {
            assert_eq!(mode_command(input), None);
        }
        for (text, prefix) in [
            ("  /re", Some((2, "/re"))),
            ("//", None),
            ("word /re", None),
            ("前 $ski", Some((4, "$ski"))),
            ("/re/path", None),
        ] {
            assert_eq!(slash_prefix(text, text.len()), prefix);
        }
    }

    #[test]
    fn only_offers_enabled_user_invocable_skills_and_preserves_provider_trigger() {
        let inventory = Inventory::decode(&json!({
            "trigger":"$",
            "skills":[
              {"name":"check","enabled":true,"userInvocable":true},
              {"name":"internal","enabled":true,"userInvocable":false},
              {"name":"disabled","enabled":false,"userInvocable":true}
            ],
            "commands":[{"name":"compact"},{"name":"review","description":"Provider command"}]
        }))
        .unwrap();
        let names = |prefix, busy| {
            choices(prefix, Some(&inventory), busy)
                .into_iter()
                .map(|choice| choice.invocation)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names("/", false),
            ["/research", "/orchestrate", "/review", "$check", "/compact"]
        );
        assert_eq!(names("$c", false), ["$check"]);
        assert_eq!(names("/o", true), ["/compact", "/review"]);
        assert!(Inventory::decode(&json!({"trigger":"?"})).is_err());
    }

    #[test]
    fn slash_picker_ranks_name_prefix_then_contains_then_description() {
        let inventory = Inventory::decode(&json!({
            "trigger":"/",
            "skills":[
              {"name":"layout","enabled":true,"userInvocable":true,"description":"Grids"},
              {"name":"relayout","enabled":true,"userInvocable":true,"description":"Move things"},
              {"name":"design","enabled":true,"userInvocable":true,"description":"Page layout and spacing"},
              {"name":"unrelated","enabled":true,"userInvocable":true,"description":"Something else entirely"}
            ],
            "commands":[]
        }))
        .unwrap();
        let names = |prefix| {
            choices(prefix, Some(&inventory), true)
                .into_iter()
                .map(|choice| choice.invocation)
                .collect::<Vec<_>>()
        };
        assert_eq!(names("/layout"), ["/layout", "/relayout", "/design"]);
        assert_eq!(names("/LAY"), ["/layout", "/relayout", "/design"]);
        assert!(names("/zzz").is_empty());
    }

    #[test]
    fn an_improved_draft_cannot_replace_new_typing_or_a_different_destination() {
        let request = Improvement {
            destination: Destination::Thread(1),
            revision: 7,
            directory: "workspace".into(),
            selection: None,
            original: "my draft".into(),
        };
        assert!(request.still_matches(Some(&Destination::Thread(1)), None, Some("workspace"), 7));
        assert!(!request.still_matches(Some(&Destination::Thread(1)), None, Some("workspace"), 8));
        assert!(!request.still_matches(Some(&Destination::Thread(2)), None, Some("workspace"), 7));
        assert!(!request.still_matches(
            Some(&Destination::Thread(1)),
            None,
            Some("new workspace"),
            7
        ));
    }
}
