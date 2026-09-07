import "carbon-components-svelte/css/all.css";
import { mount } from "svelte";
import Root from "./Root.svelte";
import "./app.css";
import "./jira.css";

mount(Root, { target: document.getElementById("app")! });
