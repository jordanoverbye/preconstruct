import nodePath from "path";
import { promptInput } from "./prompt";
import fastGlob from "fast-glob";
import * as fs from "fs-extra";
import { Item } from "./item";
import { Package } from "./package";
import { validateIncludedFiles } from "./validate-included-files";
import { FatalError } from "./errors";
import { JSONValue } from "./utils";

const allSettled = (promises: Promise<any>[]) =>
  Promise.all(
    promises.map((promise) =>
      promise.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason })
      )
    )
  );

export class Project extends Item<{
  name?: JSONValue;
  workspaces?: JSONValue;
  preconstruct: {
    globals?: Record<string, string>;
    packages?: JSONValue;
    distFilenameStrategy?: JSONValue;
    exports?: JSONValue;
    ___experimentalFlags_WILL_CHANGE_IN_PATCH: {
      logCompiledFiles?: JSONValue;
      keepDynamicImportAsDynamicImportInCommonJS?: JSONValue;
    };
  };
}> {
  get experimentalFlags() {
    let config =
      this.json.preconstruct.___experimentalFlags_WILL_CHANGE_IN_PATCH || {};
    return {
      logCompiledFiles: !!config.logCompiledFiles,
      keepDynamicImportAsDynamicImportInCommonJS: !!config.keepDynamicImportAsDynamicImportInCommonJS,
    };
  }
  get configPackages(): Array<string> {
    if (this.json.preconstruct.packages === undefined) {
      return ["."];
    }
    if (
      Array.isArray(this.json.preconstruct.packages) &&
      this.json.preconstruct.packages.every((x) => typeof x === "string")
    ) {
      return this.json.preconstruct.packages as string[];
    }

    throw new FatalError(
      "The packages option for this project is not an array of globs",
      this.name
    );
  }
  static async create(
    _directory: string,
    isFix: boolean = false
  ): Promise<Project> {
    const directory = await (fs.realpath as any).native(_directory);
    let filePath = nodePath.join(directory, "package.json");
    let contents = await fs.readFile(filePath, "utf-8");
    let project = new Project(filePath, contents, new Map());
    project.packages = await project._packages(isFix);

    return project;
  }

  get name(): string {
    if (typeof this.json.name !== "string") {
      throw new FatalError(
        "The name field on this project is not a string",
        this.directory
      );
    }
    return this.json.name;
  }

  packages!: Array<Package>;

  async _packages(isFix: boolean): Promise<Array<Package>> {
    // suport bolt later probably
    // maybe lerna too though probably not
    if (!this.json.preconstruct.packages && this.json.workspaces) {
      let workspaces;
      if (Array.isArray(this.json.workspaces)) {
        workspaces = this.json.workspaces;
      } else if (Array.isArray((this.json.workspaces as any).packages)) {
        workspaces = (this.json.workspaces as any).packages;
      }

      let packages = await promptInput(
        "what packages should preconstruct build?",
        this,
        workspaces.join(",")
      );

      this.json.preconstruct.packages = packages.split(",");

      await this.save();
    }

    let filenames = await fastGlob(this.configPackages, {
      cwd: this.directory,
      onlyDirectories: true,
      absolute: true,
    });

    let packages: Package[] = [];

    await Promise.all(
      filenames.map(async (x) => {
        try {
          packages.push(await Package.create(x, this, isFix));
        } catch (err) {
          if (
            err.code === "ENOENT" &&
            err.path === nodePath.join(x, "package.json")
          ) {
            return;
          }
          throw err;
        }
      })
    );

    const errored = (
      await allSettled(packages.map((pkg) => validateIncludedFiles(pkg)))
    ).find((result) => result.status === "rejected");

    if (errored) {
      // TS can't refine type based on .find predicate
      throw (errored as any).reason;
    }

    return packages;
  }
}
