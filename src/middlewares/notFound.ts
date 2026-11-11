import type { Request, Response } from "express";

const MESSAGE = "Not Found";

// Same JSON envelope as every controller: { success, message }.
// The text branch stays for browsers hitting the API directly.
const notFound = (req: Request, res: Response) => {
  if (req.accepts("json")) {
    res.status(404).json({ success: false, message: MESSAGE });
  } else {
    res.status(404).type("txt").send(MESSAGE);
  }
};

export default notFound;
