use crate::{
    catalog::{Catalog, prettify, provider_color},
    composer::{Composer, Queued, Submitted},
    live::ServerSource,
    mock::MockSource,
    model::{
        CatalogState, Delivery, INTERACTION_MODES, NewThread, QueueEdit, RUNTIME_MODES, Reply,
        Selection, Status, ThreadId, ThreadSource,
    },
    theme::{self, color},
};
use gpui::{prelude::*, *};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

/// The turn keeps at least this width; the inspector gives way first.
const MIN_TURN: f32 = 480.;
const MIN_INSPECTOR: f32 = 320.;

/// The menu open over the composer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dropdown {
    Project,
    Access,
    Mode,
}

/// Focus handles for toolbar controls that show a tip under keyboard focus.
pub struct Tips {
    pub jump: FocusHandle,
    pub tasks: FocusHandle,
    pub inspector: FocusHandle,
    pub stop: FocusHandle,
    pub send: FocusHandle,
}

pub struct Workspace {
    pub source: Box<dyn ThreadSource>,
    pub selected: ThreadId,
    /// Set once a thread has been picked by default, so a later snapshot does not move the selection.
    chosen: bool,
    pub sidebar_focus: FocusHandle,
    pub composers: Vec<Entity<Composer>>,
    /// Drafting a thread: the transcript and the thread's composer give way to
    /// the new-thread composer and its choices.
    pub creating: bool,
    pub new_composer: Entity<Composer>,
    /// The project a new thread starts in (a project id), until one is picked.
    pub new_project: Option<String>,
    /// The access chosen for the new thread; none leaves it to the server.
    pub new_runtime: Option<usize>,
    pub new_interaction: usize,
    /// The model chosen for the new thread; none starts it on its project's.
    pub new_model: Option<Selection>,
    pub dropdown: Option<Dropdown>,
    /// Takes keys while an approval or question is open in the composer's place.
    pub ask_focus: FocusHandle,
    /// The answers given to the open request.
    pub draft: crate::ask::Draft,
    /// The field for a written answer is open.
    pub custom_open: bool,
    pub custom_input: Entity<Composer>,
    /// The last thing that went wrong, until it is dismissed.
    pub problem: Option<String>,
    pub lists: Vec<ListState>,
    /// Opened steps, with when each opened (for the expand transition).
    pub expanded: HashMap<(ThreadId, usize), Instant>,
    pub inspector_open: bool,
    pub tasks_open: bool,
    pub picker_open: bool,
    pub palette_open: bool,
    pub model_focus: FocusHandle,
    pub group: usize,
    pub tab: usize,
    pub search: Entity<Composer>,
    /// Runs of steps the user flipped from their default (folded unless last), by thread and first step.
    pub fold_toggled: HashSet<(ThreadId, usize)>,
    pub unfolded_at: HashMap<(ThreadId, usize), Instant>,
    /// The transcript each thread's list was last sized for (live sources only).
    shown: HashMap<ThreadId, std::sync::Arc<Vec<crate::model::Message>>>,
    /// The thread the source was last told to follow.
    focused: Option<ThreadId>,
    pub picker_at: Option<Instant>,
    pub inspector_at: Option<Instant>,
    pub tips: Tips,
    pub settled_open: bool,
    pub inspector_width: f32,
    pub resizing_inspector: bool,
    /// The Git and Diff tabs' own state.
    pub git_ui: crate::git_view::GitUi,
    pub work_ui: crate::work_view::WorkUi,
    pub work_focus: FocusHandle,
    /// The stats overlay: open, and the tab and range it shows.
    pub stats_open: bool,
    pub stats_tab: crate::stats::StatsTab,
    pub stats_range: crate::stats::StatsRange,
    /// The sidebar Stats row is hovered: its tip shows to the right of the
    /// row instead of a window tooltip over the label.
    pub stats_tip: bool,
    _subscriptions: Vec<Subscription>,
}
impl Workspace {
    pub fn new(demo: bool, window: &Window, cx: &mut Context<Self>) -> Self {
        // The real server, unless the window is a demo stage (the `live` stage
        // looks at the real server) or asked for the fixtures with `--mock`.
        let stage = std::env::args().nth(2);
        let mock =
            (demo && stage.as_deref() != Some("live")) || std::env::args().any(|a| a == "--mock");
        let source: Box<dyn ThreadSource> = if mock {
            Box::new(MockSource::preview())
        } else {
            Box::new(ServerSource::connect(crate::wire::default_endpoint()))
        };
        let mut subscriptions = vec![];
        let new_composer = cx.new(|cx| {
            let mut c = Composer::new(cx);
            c.placeholder = "What should the agent do?";
            c
        });
        subscriptions.push(
            cx.subscribe(&new_composer, |_, _, _: &crate::composer::Changed, cx| {
                cx.notify()
            }),
        );
        subscriptions.push(
            cx.subscribe(&new_composer, |this, _, event: &Submitted, cx| {
                this.start_thread(event.0.clone(), cx)
            }),
        );
        subscriptions.push(cx.subscribe(&new_composer, |this, _, event: &Queued, cx| {
            this.start_thread(event.0.clone(), cx)
        }));
        let custom_input = cx.new(|cx| {
            let mut c = Composer::new(cx);
            c.placeholder = "Write your answer";
            c.height = 40.;
            c
        });
        subscriptions.push(
            cx.subscribe(&custom_input, |_, _, _: &crate::composer::Changed, cx| {
                cx.notify()
            }),
        );
        subscriptions.push(cx.subscribe_in(
            &custom_input,
            window,
            |this, _, event: &Submitted, window, cx| this.submit_custom(&event.0, window, cx),
        ));
        let git_input = cx.new(|cx| {
            let mut c = Composer::new(cx);
            c.height = 40.;
            c
        });
        subscriptions.push(
            cx.subscribe(&git_input, |_, _, _: &crate::composer::Changed, cx| {
                cx.notify()
            }),
        );
        subscriptions.push(cx.subscribe_in(
            &git_input,
            window,
            |this, _, event: &Submitted, window, cx| this.submit_form(&event.0, window, cx),
        ));
        let search = cx.new(|cx| {
            let mut c = Composer::new(cx);
            c.placeholder = "Search models";
            c.surface = "raised";
            c.height = 24.;
            c.size = 14.;
            c
        });
        subscriptions.push(
            cx.subscribe(&search, |_, _, _: &crate::composer::Changed, cx| {
                cx.notify()
            }),
        );
        // Redraws when the source's data changes, and each second while a turn
        // runs so its timer counts.
        cx.spawn(async move |this, cx| {
            let mut seen = None;
            let mut ticks = 0u32;
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
                ticks = (ticks + 1) % 20;
                if this
                    .update(cx, |this, cx| {
                        if ticks == 0 {
                            this.refresh_work();
                            this.refresh_usage();
                        }
                        let revision = this.source.revision();
                        if seen != Some(revision) {
                            seen = Some(revision);
                            this.sync_threads(cx);
                            cx.notify();
                        } else if ticks.is_multiple_of(10)
                            && this
                                .source
                                .list_threads()
                                .iter()
                                .any(|t| t.started_at.is_some())
                        {
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        if demo {
            cx.spawn_in(window, async move |this, cx| {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let stage = std::env::args().nth(2).unwrap_or_else(|| "main".into());
                this.update_in(cx, |this, window, cx| {
                    match stage.as_str() {
                        "picker" => {
                            this.toggle_picker(window, cx);
                        }
                        "details" => {
                            this.expanded.insert((0, 4), Instant::now());
                            this.lists[0].splice(4..5, 1);
                            this.source.open_commit(0, "5a7bee1");
                            this.git_ui
                                .expanded
                                .insert("commit-5a7bee1:src/workspace.rs".into());
                        }
                        "focus" => {
                            window.focus(&this.tips.tasks, cx);
                        }
                        "input" => {
                            this.stop(cx);
                            this.composers[0]
                                .clone()
                                .update(cx, |c, cx| c.demo_send(window, cx));
                        }
                        _ => {}
                    }
                    cx.notify();
                })
                .expect("demo window is attached");
                if stage == "focus" {
                    cx.update(|window, cx| {
                        window.dispatch_event(
                            PlatformInput::KeyDown(KeyDownEvent {
                                keystroke: Keystroke::parse("tab").expect("tab keystroke"),
                                is_held: false,
                                prefer_character_input: false,
                            }),
                            cx,
                        );
                        // Tab put the window in keyboard mode; land on the
                        // inspector toggle, whose tip names its shortcut.
                        this.update(cx, |this, cx| window.focus(&this.tips.inspector, cx))
                            .expect("workspace is alive");
                    })
                    .expect("demo window is attached");
                }
                cx.background_executor().timer(Duration::from_secs(2)).await;
                #[cfg(feature = "render-harness")]
                capture(cx, &format!("harness-{stage}.png"));
                println!("demo: ready {stage} pid={}", std::process::id());
            })
            .detach();
        }
        let mut this = Self {
            git_ui: crate::git_view::GitUi::new(git_input),
            work_ui: crate::work_view::WorkUi::default(),
            work_focus: cx.focus_handle(),
            creating: false,
            new_composer,
            new_project: None,
            new_runtime: None,
            new_interaction: 0,
            new_model: None,
            dropdown: None,
            ask_focus: cx.focus_handle(),
            draft: crate::ask::Draft::default(),
            custom_open: false,
            custom_input,
            problem: None,
            source,
            fold_toggled: HashSet::new(),
            unfolded_at: HashMap::new(),
            shown: HashMap::new(),
            focused: None,
            picker_at: None,
            inspector_at: None,
            tips: Tips {
                jump: cx.focus_handle(),
                tasks: cx.focus_handle(),
                inspector: cx.focus_handle(),
                stop: cx.focus_handle(),
                send: cx.focus_handle(),
            },
            settled_open: false,
            inspector_width: theme::INSPECTOR,
            resizing_inspector: false,
            search,
            inspector_open: true,
            tasks_open: true,
            picker_open: false,
            palette_open: false,
            stats_open: false,
            stats_tab: crate::stats::StatsTab::default(),
            stats_range: crate::stats::StatsRange::default(),
            stats_tip: false,
            model_focus: cx.focus_handle(),
            group: 1,
            tab: 1,
            selected: 0,
            chosen: false,
            sidebar_focus: cx.focus_handle(),
            composers: vec![],
            lists: vec![],
            expanded: HashMap::new(),
            _subscriptions: subscriptions,
        };
        this.sync_threads(cx);
        this
    }
    /// Gives every thread the source lists a composer and a transcript list,
    /// and keeps the selection on a thread that is still listed. Threads only
    /// ever appear: the source keeps a gone thread's id.
    pub fn sync_threads(&mut self, cx: &mut Context<Self>) {
        let count = self.source.list_threads().len();
        while self.composers.len() < count {
            let id = self.composers.len();
            let composer = cx.new(Composer::new);
            self._subscriptions.push(
                cx.subscribe(&composer, |_, _, _: &crate::composer::Changed, cx| {
                    cx.notify()
                }),
            );
            self._subscriptions.push(cx.subscribe(
                &composer,
                move |this, _, event: &Submitted, cx| {
                    this.send(id, event.0.clone(), Delivery::Steer, cx)
                },
            ));
            self._subscriptions.push(cx.subscribe(
                &composer,
                move |this, _, event: &Queued, cx| {
                    this.send(id, event.0.clone(), Delivery::Queue, cx)
                },
            ));
            self.composers.push(composer);
        }
        while self.lists.len() < count {
            let id = self.lists.len();
            let messages = self.source.messages(id);
            self.lists.push(ListState::new(
                messages.len(),
                ListAlignment::Top,
                px(theme::HEIGHT),
            ));
            self.shown.insert(id, messages);
        }
        let listed = self.source.order(false);
        if !self.chosen && !listed.is_empty() {
            // The first row the sidebar shows, not a settled thread behind
            // its closed section.
            let threads = self.source.list_threads();
            let top = self
                .source
                .order(true)
                .into_iter()
                .find(|&i| !threads[i].settled);
            self.selected = top.unwrap_or(listed[0]);
            self.chosen = true;
        } else if !listed.contains(&self.selected)
            && let Some(&first) = listed.first()
        {
            self.selected = first;
        }
        if !listed.is_empty() && self.focused != Some(self.selected) {
            self.focused = Some(self.selected);
            self.source.focus(self.selected);
        }
        self.sync_transcript();
        self.take_news(cx);
    }
    /// What the source reports since the last look: a thread this window
    /// started, a project it added, and anything that failed.
    fn take_news(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.source.take_opened()
            && id < self.composers.len()
        {
            self.creating = false;
            self.selected = id;
            self.focused = None;
            self.new_composer
                .update(cx, |c, cx| c.set_text(String::new(), cx));
        }
        if let Some(project) = self.source.take_added() {
            self.new_project = Some(project);
        }
        while let Some(problem) = self.source.take_problem() {
            self.problem = Some(problem.message);
            let Some((at, text)) = problem.unsent else {
                continue;
            };
            let composer = match at {
                Some(id) if id < self.composers.len() => self.composers[id].clone(),
                _ => {
                    self.creating = true;
                    self.new_composer.clone()
                }
            };
            composer.update(cx, |c, cx| {
                // Anything typed since stays after the text that did not go.
                let typed = c.text().to_string();
                c.set_text(
                    if typed.is_empty() {
                        text
                    } else {
                        format!("{text}\n{typed}")
                    },
                    cx,
                );
            });
        }
    }
    /// The project a new thread starts in: the one picked, else the open
    /// thread's, else the newest.
    pub fn new_project_id(&self) -> Option<String> {
        let projects = self.source.projects();
        self.new_project
            .clone()
            .filter(|id| projects.iter().any(|p| &p.id == id))
            .or_else(|| {
                let open = self
                    .source
                    .list_threads()
                    .get(self.selected)?
                    .project
                    .clone();
                projects
                    .iter()
                    .find(|p| p.title == open)
                    .map(|p| p.id.clone())
            })
            .or_else(|| projects.first().map(|p| p.id.clone()))
    }
    /// The model the open thread runs on, or the new thread would start on.
    pub fn effective_selection(&self) -> Option<Selection> {
        if self.creating {
            self.new_model
                .clone()
                .or_else(|| self.source.project_selection(&self.new_project_id()?))
        } else {
            self.source.selection(self.selected)
        }
    }
    /// The catalog, once read.
    pub fn catalog(&self) -> Option<std::sync::Arc<Catalog>> {
        match self.source.catalog() {
            CatalogState::Ready(catalog) => Some(catalog),
            _ => None,
        }
    }
    /// A model's name and the token it is drawn in: the catalog's name once
    /// known, a readable form of the slug until then.
    pub fn model_label(&self, selection: Option<&Selection>) -> (String, &'static str) {
        let Some(selection) = selection else {
            return ("Default model".into(), "ink");
        };
        let catalog = self.catalog();
        let name = catalog
            .as_ref()
            .map_or_else(|| prettify(&selection.model), |c| c.model_name(selection));
        let driver = catalog
            .as_ref()
            .and_then(|c| c.provider(&selection.instance))
            .map_or("", |p| p.driver.as_str());
        (name, provider_color(driver, &selection.instance))
    }
    /// Switches the model of the open thread, or of the new one: what still
    /// applies of the old choice carries over (`Catalog::rebase`).
    pub fn choose_model(&mut self, instance: &str, model: &str, cx: &mut Context<Self>) {
        let Some(catalog) = self.catalog() else {
            return;
        };
        let next = catalog.rebase(self.effective_selection().as_ref(), instance, model);
        self.apply_selection(next);
        self.picker_open = false;
        cx.notify();
    }
    /// Sets one option of the current model, e.g. its reasoning level.
    pub fn choose_option(&mut self, option: &str, value: &str, cx: &mut Context<Self>) {
        if let Some(current) = self.effective_selection() {
            self.apply_selection(current.with_option(option, value));
            cx.notify();
        }
    }
    fn apply_selection(&mut self, selection: Selection) {
        if self.creating {
            self.new_model = Some(selection);
        } else {
            self.source.set_model(self.selected, selection);
        }
    }
    pub fn new_project_title(&self) -> Option<String> {
        if !self.creating {
            return None;
        }
        let id = self.new_project_id()?;
        self.source
            .projects()
            .into_iter()
            .find(|p| p.id == id)
            .map(|p| p.title)
    }
    /// Starts drafting a thread in the open thread's project.
    pub fn new_thread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.source.projects().is_empty() {
            return;
        }
        self.creating = true;
        self.new_project = None;
        self.new_model = None;
        self.dropdown = None;
        self.picker_open = false;
        window.focus(&self.new_composer.read(cx).focus.clone(), cx);
        cx.notify();
    }
    fn start_thread(&mut self, text: String, cx: &mut Context<Self>) {
        let Some(project) = self.new_project_id() else {
            self.problem = Some("There is no project to start a thread in.".into());
            self.new_composer.update(cx, |c, cx| c.set_text(text, cx));
            cx.notify();
            return;
        };
        self.source.create_thread(NewThread {
            project,
            text,
            runtime_mode: self.new_runtime.map(|at| RUNTIME_MODES[at].0.into()),
            interaction_mode: INTERACTION_MODES[self.new_interaction].0.into(),
            model: self.new_model.clone(),
        });
        // Stays in the draft view until the thread is listed; the source then
        // names it (`take_opened`), which the redraw loop picks up.
        cx.notify();
    }
    /// Adds a folder as a project, asking for it with the system's picker.
    pub fn add_project(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Add project".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            let Some(path) = paths.first() else { return };
            let path = path.to_string_lossy().into_owned();
            this.update(cx, |this, cx| {
                this.source.add_project(path);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
    /// Sets how the open thread (or the new one) runs.
    pub fn set_access(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.creating {
            self.new_runtime = Some(index);
        } else {
            let thread = self.source.list_threads()[self.selected].clone();
            self.source.set_modes(
                self.selected,
                RUNTIME_MODES[index].0,
                &thread.interaction_mode,
            );
        }
        self.dropdown = None;
        cx.notify();
    }
    pub fn set_mode(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.creating {
            self.new_interaction = index;
        } else {
            let thread = self.source.list_threads()[self.selected].clone();
            self.source.set_modes(
                self.selected,
                &thread.runtime_mode,
                INTERACTION_MODES[index].0,
            );
        }
        self.dropdown = None;
        cx.notify();
    }
    pub fn edit_queued(&mut self, key: &str, edit: QueueEdit, cx: &mut Context<Self>) {
        self.source.edit_queued(self.selected, key, edit);
        cx.notify();
    }
    /// Takes a waiting message back into the draft to change it.
    pub fn edit_queued_text(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = self.source.take_queued(self.selected, key) {
            let composer = self.composers[self.selected].clone();
            composer.update(cx, |c, cx| {
                let typed = c.text().to_string();
                c.set_text(
                    if typed.is_empty() {
                        text
                    } else {
                        format!("{text}\n{typed}")
                    },
                    cx,
                );
            });
            window.focus(&composer.read(cx).focus.clone(), cx);
            cx.notify();
        }
    }
    /// Re-reads usage while it is on screen: the account's limits and
    /// protection on their timers, and the open thread's context on the TUI's
    /// timer — the status line shows it whether or not the Context tab does.
    pub fn refresh_usage(&mut self) {
        if self.source.preview() {
            return;
        }
        self.source.read_limits();
        self.source.read_protection();
        if !self.creating {
            self.source.read_context(self.selected);
        }
        if self.stats_open && self.source.stats(self.stats_range).is_none() {
            self.source.read_stats(self.stats_range);
        }
    }
    /// Resizes the open thread's list to a live transcript that changed:
    /// everything from the first changed row is measured again, and a reader
    /// who is at the end stays there as it grows. The mock changes its list
    /// itself, so it is left alone.
    fn sync_transcript(&mut self) {
        if self.source.preview() || self.selected >= self.lists.len() {
            return;
        }
        let id = self.selected;
        let now = self.source.messages(id);
        let Some(before) = self.shown.get(&id).cloned() else {
            return;
        };
        if std::sync::Arc::ptr_eq(&before, &now) {
            return;
        }
        let common = before
            .iter()
            .zip(now.iter())
            .take_while(|(a, b)| a == b)
            .count();
        let list = &self.lists[id];
        // Following the end: the first thing seen, or one of the last rows on screen.
        let following = before.is_empty() || list.logical_scroll_top().item_ix + 8 >= before.len();
        list.splice(common..before.len(), now.len() - common);
        if following {
            list.scroll_to_end();
        }
        self.shown.insert(id, now);
    }
    /// Whether a run of `len` steps starting at `start` shows only its summary.
    /// Finished runs fold; the last run of the thread stays open while it is
    /// the end of the conversation. A click flips either.
    pub fn run_folded(&self, id: ThreadId, start: usize, len: usize, total: usize) -> bool {
        (start + len != total) != self.fold_toggled.contains(&(id, start))
    }
    /// The composer the window is writing into: the new thread's, or the open one's.
    pub fn active_composer(&self) -> &Entity<Composer> {
        if self.creating {
            &self.new_composer
        } else {
            &self.composers[self.selected]
        }
    }
    pub fn retry(&mut self, cx: &mut Context<Self>) {
        self.source.retry();
        cx.notify();
    }
    pub fn select(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        self.selected = id;
        self.creating = false;
        self.dropdown = None;
        cx.notify();
    }
    pub fn open_stats(&mut self, cx: &mut Context<Self>) {
        self.stats_open = true;
        self.stats_tab = crate::stats::StatsTab::default();
        self.source.read_stats(self.stats_range);
        cx.notify();
    }
    pub fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.palette_open = true;
        self.picker_open = false;
        self.search.update(cx, |c, cx| {
            c.placeholder = "Search threads";
            c.set_text(String::new(), cx);
        });
        window.focus(&self.search.read(cx).focus.clone(), cx);
        cx.notify();
    }
    /// Opens or closes the inspector, timing the slide.
    pub fn set_inspector(&mut self, open: bool) {
        if self.inspector_open != open {
            self.inspector_open = open;
            self.inspector_at = Some(Instant::now());
        }
    }
    pub fn toggle_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.picker_open = !self.picker_open;
        if self.picker_open {
            // A model may have been hidden or a provider signed in since it was read.
            self.source.refresh_catalog();
        }
        self.picker_at = Some(Instant::now());
        self.palette_open = false;
        self.search.update(cx, |c, cx| {
            c.placeholder = "Search models";
            c.set_text(String::new(), cx);
        });
        window.focus(
            &if self.picker_open {
                self.search.read(cx).focus.clone()
            } else {
                self.model_focus.clone()
            },
            cx,
        );
        cx.notify();
    }
    pub fn stop(&mut self, cx: &mut Context<Self>) {
        // Escape also reaches here with nothing running; that interrupts nothing.
        let running = self.source.list_threads()[self.selected].status == Status::Running;
        if !running && !self.source.preview() {
            return;
        }
        self.source.stop(self.selected);
        self.composers[self.selected].update(cx, |c, cx| {
            c.enabled = true;
            cx.notify();
        });
        cx.notify();
    }
    fn send(&mut self, id: ThreadId, text: String, delivery: Delivery, cx: &mut Context<Self>) {
        let reply = self.source.send_message(id, text, delivery);
        self.animate(id, reply, cx);
    }
    /// Plays a simulated reply (the mock's); a live source has none.
    fn animate(&mut self, id: ThreadId, reply: Option<Reply>, cx: &mut Context<Self>) {
        let Some(reply) = reply else {
            cx.notify();
            return;
        };
        self.lists[id].splice(reply.message - 1..reply.message - 1, 2);
        self.lists[id].scroll_to_end();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let count = reply.words.len();
            for (i, word) in reply.words.into_iter().enumerate() {
                cx.background_executor()
                    .timer(Duration::from_millis(65))
                    .await;
                if this
                    .update(cx, |this, cx| {
                        this.source
                            .stream_word(id, reply.message, &word, i + 1 == count);
                        if i + 1 == count
                            && this.source.list_threads()[id].status
                                != crate::model::Status::Running
                        {
                            this.composers[id].update(cx, |c, cx| {
                                c.enabled = true;
                                cx.notify();
                            });
                        }
                        this.lists[id].splice(reply.message..reply.message + 1, 1);
                        this.lists[id].scroll_to_end();
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }
    /// Stops the running turn so the waiting message goes next.
    pub fn send_queued_now(&mut self, key: &str, cx: &mut Context<Self>) {
        let reply = self.source.send_queued_now(self.selected, key);
        self.animate(self.selected, reply, cx);
    }
}

#[cfg(feature = "render-harness")]
fn capture(cx: &mut AsyncWindowContext, name: &str) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("screenshots")
            .join(name);
        window
            .render_to_image()
            .expect("render demo frame")
            .save(path)
            .expect("save demo frame");
    })
    .expect("demo window remains open");
}
impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // A snapshot can arrive between two polls; never draw a thread that
        // has no composer or list yet.
        self.sync_threads(cx);
        if self.source.order(false).is_empty() {
            return crate::connection::render(self, cx).into_any_element();
        }
        self.sync_panel(window, cx);
        self.sync_inspector();
        self.sync_work();
        let viewport = f32::from(window.viewport_size().width);
        let room = (viewport - theme::SIDEBAR - MIN_TURN).max(MIN_INSPECTOR);
        let slide = crate::ui::progress(self.inspector_at, 160, window);
        let shown = if self.inspector_open {
            slide
        } else {
            1. - slide
        };
        let inspector_width = self.inspector_width.clamp(MIN_INSPECTOR, room);
        div()
            .relative()
            .font_family(theme::FONT)
            .size_full()
            .flex()
            .flex_col()
            .bg(color("ground"))
            .on_action(
                cx.listener(|this, _: &crate::palette::OpenPalette, window, cx| {
                    this.open_palette(window, cx)
                }),
            )
            .on_action(
                cx.listener(|_, _: &crate::palette::NextFocus, window, cx| window.focus_next(cx)),
            )
            .on_action(
                cx.listener(|_, _: &crate::palette::PreviousFocus, window, cx| {
                    window.focus_prev(cx)
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::palette::Dismiss, window, cx| {
                    if this.stats_open {
                        this.stats_open = false;
                    } else if this.custom_open {
                        this.close_custom(window, cx);
                    } else if this.git_ui.form.is_some() {
                        this.close_form(window, cx);
                    } else if this.dropdown.is_some() {
                        this.dropdown = None;
                    } else if this.picker_open {
                        this.picker_open = false;
                        window.focus(&this.model_focus, cx);
                    } else if this.palette_open {
                        this.palette_open = false;
                        window.focus(&this.sidebar_focus, cx);
                    } else if this.creating {
                        this.creating = false;
                        window.focus(&this.sidebar_focus, cx);
                    } else {
                        use crate::work_view::Escape;
                        match this.work_ui.escape(this.source.as_ref(), this.selected) {
                            Escape::CloseDetail | Escape::KeepApproval => {}
                            Escape::DismissQuestion => this.dismiss_ask(cx),
                            Escape::StopTurn => this.stop(cx),
                        }
                    }
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                if this.resizing_inspector {
                    let viewport = f32::from(window.viewport_size().width);
                    this.inspector_width =
                        f32::from(window.viewport_size().width - event.position.x).clamp(
                            MIN_INSPECTOR,
                            (viewport - theme::SIDEBAR - MIN_TURN).max(MIN_INSPECTOR),
                        );
                    cx.notify();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| {
                    this.resizing_inspector = false;
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::title_bar::ToggleInspector, _, cx| {
                    this.set_inspector(!this.inspector_open);
                    cx.notify();
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::title_bar::ToggleTasks, _, cx| {
                    if this.inspector_open {
                        this.tasks_open = !this.tasks_open;
                    } else {
                        this.tasks_open = true;
                        this.set_inspector(true);
                    }
                    cx.notify();
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::model_picker::TogglePicker, window, cx| {
                    this.toggle_picker(window, cx)
                }),
            )
            .text_size(px(theme::UI))
            .line_height(px(theme::UI_LINE))
            .text_color(color("ink"))
            .child(crate::title_bar::render(self, window, cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(crate::sidebar::render(self, window, cx))
                    .child(crate::thread_view::render(self, window, cx))
                    .when(shown > 0., |s| {
                        // Slides in from the window's right edge: the pane
                        // keeps its width and the clip around it grows.
                        s.child(
                            div()
                                .h_full()
                                .flex_shrink_0()
                                .flex()
                                .justify_end()
                                .overflow_hidden()
                                .w(px(inspector_width * shown))
                                .opacity(0.4 + 0.6 * shown)
                                .child(crate::inspector::render(self, inspector_width, cx)),
                        )
                    }),
            )
            .when(self.palette_open, |s| {
                s.child(crate::palette::render(self, cx))
            })
            .when(self.stats_open, |s| s.child(crate::stats::render(self, cx)))
            .when(self.stats_tip, |s| {
                // To the right of the sidebar's Stats row: a window tooltip
                // here would flip up over the label, since the footer sits
                // at the window's edge. The footer is padding 8 with three
                // 30px rows; Stats is second.
                let top = f32::from(window.viewport_size().height) - 106. + 38.;
                s.child(
                    div()
                        .absolute()
                        .left(px(theme::SIDEBAR + 8.))
                        .top(px(top.max(0.)))
                        .flex()
                        .items_center()
                        .px(px(8.))
                        .py(px(5.))
                        .rounded(px(theme::px_token("radius", "radius-sm")))
                        .bg(color("raised"))
                        .shadow(theme::float_shadow())
                        .font_family(theme::FONT)
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .text_color(color("ink"))
                        .child("Usage stats"),
                )
            })
            .into_any_element()
    }
}
