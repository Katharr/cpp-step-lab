"""调用实例和变量身份；区分递归、遮蔽与重新进入调用。"""


class FrameIdentities:
    def __init__(self):
        self.alive = {}
        self.serial = 0

    def annotate(self, frames, raw_variables, run_id):
        frame_keys = {frame["key"] for frame in frames}
        for key in frame_keys:
            if key not in self.alive:
                self.serial += 1
                self.alive[key] = self.serial
        self.alive = {key: value for key, value in self.alive.items() if key in frame_keys}
        for frame in frames:
            frame["id"] = f"{run_id}:f{self.alive[frame['key']]}"
        variables = []
        for item in raw_variables:
            item = dict(item)
            owner = "global" if item["kind"] == "global" else f"f{self.alive[item['frameKey']]}"
            item["id"] = f"{run_id}:{owner}:{item['scope']}:{item['declaration']}:{item['name']}"
            variables.append(item)
        return variables
