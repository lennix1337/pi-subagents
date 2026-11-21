import { createFakeChildSessions } from "./fake-child-session.ts";

export default function createRunnerChildSessionFactory() {
	return createFakeChildSessions(() => {
		const dir = process.env.MOCK_PI_QUEUE_DIR;
		if (!dir) throw new Error("MOCK_PI_QUEUE_DIR is required for the scripted runner child session factory.");
		return dir;
	}).factory;
}
